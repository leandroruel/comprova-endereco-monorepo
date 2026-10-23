import {
  FISCAL_SOURCE_KIND,
  FISCAL_VERIFICATION_CONTRACT_VERSION,
  FiscalAdapterUnavailableError,
  fiscalCheckerId,
  fiscalCheckerVersion,
  fiscalDocumentFingerprint,
  fiscalEvidenceSourceRef,
  fiscalVerificationStatusOf,
  stanceForDimensions,
  unavailableFiscalVerification,
  unsupportedFiscalVerification,
  type FiscalAdapter,
  type FiscalLookupInput,
  type FiscalVerificationResult,
} from '@comprova/core'
import { withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import type { Db } from '@comprova/db'
import type { Logger } from '@comprova/observability'
import { fiscalVerificationResultSchema } from '@comprova/providers'
import { createHash, randomUUID } from 'node:crypto'
import {
  loadClaimVerificationContext,
  type ClaimVerificationContext,
} from '../evidence-verification/claim-context.js'

/**
 * F2.1 — materialização de uma fonte fiscal em `claim_evidence`.
 *
 * O fluxo é:
 *
 *   FiscalLookupInput -> FiscalAdapter.verify -> FiscalVerificationResult
 *     -> uma observação em `claim_evidence` (detail.verification)
 *
 * Garantias:
 *   - o adapter não pontua nem aprova; `stance` vem da política compartilhada,
 *     `strength`/`confidence` ficam neutros e NÃO há `signal`;
 *   - `unavailable`/`inconclusive`/`unsupported` nunca viram `contradicts`;
 *   - a mesma consulta (claim + fonte + documento + versão do adapter) não
 *     duplica; uma nova versão preserva a anterior;
 *   - toda leitura/escrita do claim usa `withTenant`/RLS;
 *   - a resposta bruta não é persistida: apenas outcomes, hashes e metadados.
 *
 * A execução concreta da NF3e (allowlist, fetch e parsing) é F2.2. Este módulo
 * é o ponto de extensão exercitado pelo `FakeFiscalAdapter`.
 */

export interface FiscalVerificationDeps {
  readonly db: Db
  readonly adapter: FiscalAdapter
  readonly logger?: Logger
  readonly now?: () => Date
}

export type FiscalMaterializationOutcome = 'inserted' | 'duplicate' | 'skipped'

const SAFE_REASON = /^[A-Z0-9_]{1,64}$/

const safeReason = (reason: string): string => (SAFE_REASON.test(reason) ? reason : 'ADAPTER_ERROR')

const hashNullable = (value: string | null): string | null =>
  value === null ? null : createHash('sha256').update(value).digest('hex')

const artifactSha256 = (value: string | undefined): Buffer | null =>
  value !== undefined && /^[a-f0-9]{64}$/.test(value) ? Buffer.from(value, 'hex') : null

const verificationDetailOf = (
  result: FiscalVerificationResult,
  input: FiscalLookupInput,
): Record<string, unknown> => ({
  verification: {
    status: fiscalVerificationStatusOf(result.document),
    method: result.method,
    source: fiscalEvidenceSourceRef(result.source, result.issuer, result.environment),
    document: result.document,
    address: result.address,
    holder: result.holder,
    // Hash estável do documento consultado, nunca a chave/URL crua.
    document_ref_hash: fiscalDocumentFingerprint(input),
    adapter_version: result.adapterVersion,
    contract_version: FISCAL_VERIFICATION_CONTRACT_VERSION,
    observed_at: result.observedAt.toISOString(),
    issued_at: result.issuedAt?.toISOString() ?? null,
    limitations: [...result.limitations],
    error_codes: [...result.errorCodes],
    audit: {
      requested_url_sha256: hashNullable(result.audit.requestedUrl),
      resolved_ip: result.audit.resolvedIp,
      response_status: result.audit.responseStatus,
      response_sha256: result.audit.responseSha256,
    },
    query: {
      uf: input.uf,
      qr_present: input.qrCodeUrl !== null,
    },
  },
})

const runAdapter = async (
  deps: FiscalVerificationDeps,
  input: FiscalLookupInput,
  context: ClaimVerificationContext,
  now: () => Date,
): Promise<FiscalVerificationResult> => {
  let supported = false
  try {
    supported = deps.adapter.source === input.source && deps.adapter.supports(input)
  } catch (error) {
    deps.logger?.warn(
      {
        source: input.source,
        reason: 'FISCAL_ADAPTER_SUPPORTS_FAILED',
        error_name: error instanceof Error ? error.name : 'unknown',
      },
      'fiscal adapter supports failed',
    )
    return unavailableFiscalVerification(input, deps.adapter.version, now(), 'ADAPTER_ERROR')
  }

  if (!supported) {
    return unsupportedFiscalVerification(input, deps.adapter.version, now(), 'SOURCE_NOT_SUPPORTED')
  }

  let raw: unknown
  try {
    raw = await deps.adapter.verify(input, {
      tenantId: input.tenantId,
      claim: { address: context.addressTarget, holder: context.holderReference },
      now,
    })
  } catch (error) {
    const reason = error instanceof FiscalAdapterUnavailableError ? safeReason(error.reason) : 'ADAPTER_ERROR'
    deps.logger?.warn(
      {
        source: input.source,
        reason: 'FISCAL_ADAPTER_UNAVAILABLE',
        error_name: error instanceof Error ? error.name : 'unknown',
        error_code: reason,
      },
      'fiscal adapter unavailable',
    )
    return unavailableFiscalVerification(input, deps.adapter.version, now(), reason)
  }

  const parsed = fiscalVerificationResultSchema.safeParse(raw)
  if (!parsed.success) {
    deps.logger?.warn(
      { source: input.source, reason: 'FISCAL_ADAPTER_RESULT_INVALID' },
      'fiscal adapter result invalid',
    )
    return unavailableFiscalVerification(input, deps.adapter.version, now(), 'ADAPTER_RESULT_INVALID')
  }

  if (parsed.data.source !== input.source) {
    return unavailableFiscalVerification(input, deps.adapter.version, now(), 'ADAPTER_RESULT_SOURCE_MISMATCH')
  }
  if (parsed.data.adapterVersion !== deps.adapter.version) {
    return unavailableFiscalVerification(
      input,
      deps.adapter.version,
      now(),
      'ADAPTER_RESULT_VERSION_MISMATCH',
    )
  }

  return parsed.data
}

/**
 * Executa o adapter e materializa o resultado. Retorna `skipped` quando o
 * claim não existe no tenant informado; `inserted`/`duplicate` usam a chave
 * única `(claim, source, checker, checker_version)`.
 */
export const verifyFiscalClaim = async (
  deps: FiscalVerificationDeps,
  input: FiscalLookupInput,
): Promise<FiscalMaterializationOutcome> => {
  const now = deps.now ?? (() => new Date())
  const context = await loadClaimVerificationContext(deps.db, input.tenantId, input.claimId)
  if (context === null) return 'skipped'

  const result = await runAdapter(deps, input, context, now)
  const observedAt = result.observedAt
  const ttlSeconds = Math.max(0, Math.floor((context.expiresAt.getTime() - observedAt.getTime()) / 1000))
  const evidenceSha256 = artifactSha256(input.artifact?.sha256)

  const inserted = await withTenant(deps.db, input.tenantId, async (tx) => {
    const rows = await tx
      .insert(t.claimEvidence)
      .values({
        claimEvidenceId: randomUUID(),
        tenantId: input.tenantId,
        claimId: input.claimId,
        signalId: null,
        evidenceId: null,
        evidenceSha256,
        checker: fiscalCheckerId(result.source),
        checkerVersion: fiscalCheckerVersion(result.adapterVersion, input),
        stance: stanceForDimensions(result),
        // F2.1 não emite signal; a F3 decide peso/força da fonte fiscal.
        strength: 0,
        confidence: 0,
        source: FISCAL_SOURCE_KIND[result.source],
        observedAt,
        ttlSeconds,
        expiresAt: context.expiresAt,
        detail: verificationDetailOf(result, input),
        createdAt: now(),
      })
      .onConflictDoNothing()
      .returning({ claimEvidenceId: t.claimEvidence.claimEvidenceId })
    return rows.length > 0
  })

  if (inserted) {
    deps.logger?.debug(
      {
        source: input.source,
        claim_id: input.claimId,
        document_ref_hash: fiscalDocumentFingerprint(input),
        adapter_version: result.adapterVersion,
        document: result.document,
        address: result.address,
        holder: result.holder,
        reason: 'FISCAL_VERIFICATION_MATERIALIZED',
      },
      'fiscal verification materialized',
    )
  }

  return inserted ? 'inserted' : 'duplicate'
}
