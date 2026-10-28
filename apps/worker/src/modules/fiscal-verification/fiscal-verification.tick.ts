import type { FiscalReference } from '@comprova/core'
import { toFiscalLookupInput, type FiscalAdapter, type FiscalLookupInput } from '@comprova/core'
import { eq, sql, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import type { Db } from '@comprova/db'
import type { Logger } from '@comprova/observability'
import {
  clearVerificationAttempt,
  recordVerificationAttempt,
} from '../evidence-verification/evidence-verification.service.js'
import { verifyFiscalClaim } from './fiscal-verification.service.js'

/**
 * F2.2b/F3 — gatilho da consulta fiscal a partir da referência extraída do
 * comprovante.
 *
 * O fluxo do vertical slice:
 *
 *   intake (F1.1) → análise (F1.2, extrai `fiscalReference` do QR)
 *     → verificação do documento (F1.3, materializa `uploaded_document`)
 *     → ESTE TICK: consulta o autorizador pela referência extraída
 *       (`verifyFiscalClaim`, adapter NF3e já existente) e reavalia o claim
 *       (deep path), para que a evidência fiscal entre no assessment.
 *
 * Garantias:
 *   - a referência só é confiável pelo contexto do claim (tenant/claim do
 *     banco, nunca do artefato); `toFiscalLookupInput` rejeita referências
 *     não encontradas;
 *   - a consulta é idempotente (`verifyFiscalClaim` não duplica por
 *     claim+fonte+documento+versão do adapter);
 *   - `unavailable`/`inconclusive`/`unsupported` são materializados como
 *     observação neutra — indisponibilidade nunca vira "endereço falso";
 *   - o retry de reavaliação usa o mesmo estado de backoff por `analysis_id`
 *     do F1.3 (`evidence_verification_attempt`): uma reavaliação que falha é
 *     retentada no próximo tick, sem comando manual;
 *   - a reavaliação tem estado durável na validation (`fiscal_reassessment`):
 *     `pending` antes da materialização fiscal, `completed` só depois do
 *     `deepEnrich` — o cliente espera o assessment novo, não o anterior.
 */

const DEFAULT_BATCH_SIZE = 5

export interface FiscalCandidate {
  readonly analysisId: string
  readonly tenantId: string
  readonly artifactId: string
  readonly reference: FiscalReference
  readonly claimId: string
  readonly validationId: string
  readonly sha256: Buffer
}

export interface FiscalVerificationTickDeps {
  /** Pool de manutenção (atravessa tenants no scan); cada item usa `withTenant`. */
  readonly db: Db
  readonly adapter: FiscalAdapter
  readonly logger: Logger
  /**
   * Reavalia o claim depois da materialização fiscal (deep path). Recebe o
   * pool do app/RLS do caller — nunca o pool admin.
   */
  readonly reassess: (tenantId: string, validationId: string) => Promise<unknown>
  readonly batchSize?: number
  readonly now?: () => Date
}

const errorNameOf = (error: unknown): string => (error instanceof Error ? error.name : 'unknown')

const findCandidate = async (
  deps: FiscalVerificationTickDeps,
  excluded: ReadonlySet<string>,
): Promise<FiscalCandidate | null> => {
  const excludedClause =
    excluded.size === 0
      ? sql.empty()
      : sql`AND ea.analysis_id NOT IN (${sql.join(
          [...excluded].map((analysisId) => sql`${analysisId}`),
          sql`, `,
        )})`
  const rows = (await deps.db.execute(sql`
    SELECT ea.analysis_id,
           ea.tenant_id,
           ea.artifact_id,
           ea.result->'fiscalReference' AS reference,
           c.claim_id,
           c.validation_id,
           art.sha256
    FROM evidence_analysis ea
    JOIN evidence_artifact art
      ON art.artifact_id = ea.artifact_id
     AND art.tenant_id = ea.tenant_id
    JOIN claim_evidence ce
      ON ce.claim_evidence_id = art.claim_evidence_id
     AND ce.tenant_id = ea.tenant_id
    JOIN claim c
      ON c.claim_id = ce.claim_id
     AND c.tenant_id = ea.tenant_id
    LEFT JOIN evidence_verification_attempt eva
      ON eva.analysis_id = ea.analysis_id
     AND eva.tenant_id = ea.tenant_id
    WHERE ea.result IS NOT NULL
      AND ea.analyzed_at IS NOT NULL
      AND ea.result->'fiscalReference'->>'status' = 'found'
      AND ea.result->'fiscalReference'->>'documentId' IS NOT NULL
      AND ce.source = 'customer_submitted_document'
      -- A verificação do documento enviado (F1.3) já foi materializada: o
      -- re-assessment vê o comprovante E a consulta fiscal juntos.
      AND EXISTS (
        SELECT 1
        FROM claim_evidence v
        WHERE v.claim_id = ce.claim_id
          AND v.tenant_id = ea.tenant_id
          AND v.source = 'uploaded_document'
      )
      -- Uma consulta por claim nesta fatia (o intake é único por claim). Se a
      -- evidência fiscal já existe, o candidato só volta quando há uma
      -- tentativa de retry vencida (reavaliação que falhou).
      AND (
        NOT EXISTS (
          SELECT 1
          FROM claim_evidence f
          WHERE f.claim_id = ce.claim_id
            AND f.tenant_id = ea.tenant_id
            AND f.source = 'fiscal_nf3e'
        )
        OR (
          eva.analysis_id IS NOT NULL
          AND (eva.next_attempt_at IS NULL OR eva.next_attempt_at <= now())
        )
      )
      AND (eva.next_attempt_at IS NULL OR eva.next_attempt_at <= now())
      ${excludedClause}
    ORDER BY ea.analyzed_at, ea.analysis_id
    LIMIT 1
  `)) as unknown as readonly {
    analysis_id: string
    tenant_id: string
    artifact_id: string
    reference: FiscalReference
    claim_id: string
    validation_id: string
    sha256: Buffer
  }[]

  const row = rows[0]
  if (row === undefined) return null
  return {
    analysisId: row.analysis_id,
    tenantId: row.tenant_id,
    artifactId: row.artifact_id,
    reference: row.reference,
    claimId: row.claim_id,
    validationId: row.validation_id,
    sha256: Buffer.from(row.sha256),
  }
}

const lookupInputOf = (candidate: FiscalCandidate): FiscalLookupInput | null =>
  toFiscalLookupInput(candidate.reference, {
    tenantId: candidate.tenantId,
    claimId: candidate.claimId,
    artifact: { artifactId: candidate.artifactId, sha256: candidate.sha256.toString('hex') },
  })

/**
 * Estado durável da reavaliação (migration 0045), escrito na validation:
 *
 * - `pending` é gravado ANTES de materializar a evidência fiscal — uma queda do
 *   worker entre a consulta e a reavaliação deixa o claim `pending` (o backoff
 *   retenta), nunca um `completed` sem assessment novo;
 * - `completed` só depois de `deepEnrich` concluir: é o sinal que o cliente usa
 *   para parar de acompanhar sem exibir o veredito anterior à consulta.
 */
const setFiscalReassessment = async (
  deps: FiscalVerificationTickDeps,
  candidate: FiscalCandidate,
  state: 'pending' | 'completed',
): Promise<void> => {
  await withTenant(deps.db, candidate.tenantId, async (tx) => {
    await tx
      .update(t.validation)
      .set({ fiscalReassessment: state })
      .where(eq(t.validation.validationId, candidate.validationId))
  })
}

/**
 * Processa até `batchSize` referências fiscais pendentes. Cada item é
 * independente: uma falha registra backoff e não bloqueia os demais.
 */
export const verifyFiscalTick = async (deps: FiscalVerificationTickDeps): Promise<number> => {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE
  const now = deps.now ?? (() => new Date())
  const excluded = new Set<string>()
  let processed = 0

  while (processed < batchSize) {
    const candidate = await findCandidate(deps, excluded)
    if (candidate === null) break
    excluded.add(candidate.analysisId)
    processed += 1

    const input = lookupInputOf(candidate)
    if (input === null) {
      deps.logger.warn(
        {
          analysis_id: candidate.analysisId,
          claim_id: candidate.claimId,
          validation_id: candidate.validationId,
          reason: 'FISCAL_REFERENCE_UNUSABLE',
        },
        'fiscal reference not usable for lookup',
      )
      await recordVerificationAttempt(deps.db, candidate, 'FISCAL_REFERENCE_UNUSABLE')
      continue
    }

    try {
      // Estado durável antes da materialização: o GET passa a dizer "pending"
      // enquanto a consulta e a reavaliação estão no ar.
      await setFiscalReassessment(deps, candidate, 'pending')

      // Diagnóstico: quais metadados da referência foram extraídos e qual
      // adapter vai tentar a consulta. Não inclui chave/URL/PII.
      deps.logger.info(
        {
          validation_id: candidate.validationId,
          claim_id: candidate.claimId,
          analysis_id: candidate.analysisId,
          reference_method: candidate.reference.method,
          reference_status: candidate.reference.status,
          reference_source: candidate.reference.source,
          reference_uf: candidate.reference.uf,
          reference_issuer: candidate.reference.issuer,
          adapter_source: deps.adapter.source,
          adapter_version: deps.adapter.version,
          reason: 'FISCAL_VERIFICATION_CANDIDATE_FOUND',
        },
        'fiscal verification candidate found',
      )

      const outcome = await verifyFiscalClaim(
        { db: deps.db, adapter: deps.adapter, logger: deps.logger, now },
        input,
      )

      if (outcome === 'skipped') {
        await recordVerificationAttempt(deps.db, candidate, 'CONTEXT_MISSING')
        continue
      }

      // A evidência fiscal só entra no assessment quando o deep path roda
      // DEPOIS da materialização. A reavaliação é o último passo do fluxo.
      await deps.reassess(candidate.tenantId, candidate.validationId)
      // Só agora o resultado reflete a consulta fiscal: o cliente pode parar
      // de acompanhar sem ler o veredito anterior.
      await setFiscalReassessment(deps, candidate, 'completed')
      await clearVerificationAttempt(deps.db, candidate)
      deps.logger.info(
        {
          analysis_id: candidate.analysisId,
          claim_id: candidate.claimId,
          validation_id: candidate.validationId,
          outcome,
          reason: 'FISCAL_VERIFICATION_TICK_DONE',
        },
        'fiscal verification materialized and claim reassessed',
      )
    } catch (error) {
      deps.logger.error(
        {
          analysis_id: candidate.analysisId,
          claim_id: candidate.claimId,
          validation_id: candidate.validationId,
          reason: 'FISCAL_VERIFICATION_TICK_FAILED',
          error_name: errorNameOf(error),
        },
        'fiscal verification tick failed',
      )
      try {
        await recordVerificationAttempt(deps.db, candidate, 'FISCAL_TICK_FAILED')
      } catch (attemptError) {
        deps.logger.error(
          {
            analysis_id: candidate.analysisId,
            reason: 'FISCAL_VERIFICATION_ATTEMPT_RECORD_FAILED',
            error_name: errorNameOf(attemptError),
          },
          'fiscal verification attempt record failed',
        )
      }
    }
  }

  return processed
}
