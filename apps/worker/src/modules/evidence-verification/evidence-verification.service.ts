import type { DocumentAnalysisResult } from '@comprova/core'
import {
  CUSTOMER_DOCUMENT_INTAKE_SOURCE,
  DOCUMENT_ANALYSIS_CONTRACT_VERSION,
  DOCUMENT_ANALYZER_ID,
  DOCUMENT_ANALYZER_VERSION,
  UPLOADED_DOCUMENT_CHECKER,
  UPLOADED_DOCUMENT_SOURCE,
  stanceForVerification,
  uploadedDocumentCheckerVersion,
  verifyUploadedDocument,
  type AddressComparisonTarget,
  type HolderReference,
  type UploadedDocumentVerification,
} from '@comprova/core'
import { and, eq, sql, withTenant } from '@comprova/db'
import type { Db, DbTx } from '@comprova/db'
import * as t from '@comprova/db'
import type { Logger } from '@comprova/observability'
import { randomUUID } from 'node:crypto'
import { registryRecordFromDeepContext } from '../deep-enrich/deep-enrich.registry.js'

/**
 * F1.3 — verificação do documento enviado.
 *
 * Consome uma linha TERMINAL de `evidence_analysis` e materializa uma
 * observação própria em `claim_evidence` (`source = uploaded_document`). A
 * observação F1.1 (`customer_submitted_document`) permanece imutável e não é
 * reutilizada: ela é o recibo do intake, não a verificação.
 *
 * Garantias:
 *   - uma linha por (`claim_id`, checker, checker_version); replay/retry não
 *     duplica e uma nova versão cria outra linha sem apagar a anterior;
 *   - não há `signal`: F1.3 não altera `weightedScore`/veredito;
 *   - a leitura corrente no GET é a verificação com `observed_at` mais recente;
 *   - `unavailable`/`inconclusive`/`unsupported`/`invalid` nunca viram
 *     `contradicts` (a política F1.3 mantém `stance = unknown`);
 *   - logs usam apenas ids, status e reason codes; o `detail` não copia
 *     endereço/titular extraídos.
 */

export interface EvidenceVerificationDeps {
  readonly db: Db
  readonly logger: Logger
  /** Versão do analisador cuja análise terminal será materializada. */
  readonly analyzerId?: string
  readonly analyzerVersion?: string
  readonly contractVersion?: string
  readonly batchSize?: number
  readonly now?: () => Date
}

interface VerificationCandidate {
  readonly analysisId: string
  readonly tenantId: string
  readonly artifactId: string
  readonly analyzer: string
  readonly analyzerVersion: string
  readonly contractVersion: string
  readonly result: DocumentAnalysisResult
  readonly analyzedAt: Date
  readonly claimId: string
  readonly claimEvidenceId: string
  readonly contentType: string
  readonly sha256: Buffer
}

interface VerificationContext {
  readonly expiresAt: Date
  readonly addressTarget: AddressComparisonTarget | null
  readonly holderReference: HolderReference | null
}

const DEFAULT_BATCH_SIZE = 20

const errorNameOf = (error: unknown): string => (error instanceof Error ? error.name : 'unknown')

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value))

const versionsOf = (deps: EvidenceVerificationDeps) => ({
  analyzerId: deps.analyzerId ?? DOCUMENT_ANALYZER_ID,
  analyzerVersion: deps.analyzerVersion ?? DOCUMENT_ANALYZER_VERSION,
  contractVersion: deps.contractVersion ?? DOCUMENT_ANALYSIS_CONTRACT_VERSION,
})

const findNext = async (deps: EvidenceVerificationDeps): Promise<VerificationCandidate | null> => {
  const { analyzerId, analyzerVersion, contractVersion } = versionsOf(deps)
  const checkerVersion = uploadedDocumentCheckerVersion(analyzerVersion, contractVersion)
  const rows = (await deps.db.execute(sql`
    SELECT ea.analysis_id,
           ea.tenant_id,
           ea.artifact_id,
           ea.analyzer,
           ea.analyzer_version,
           ea.contract_version,
           ea.result,
           ea.analyzed_at,
           c.claim_id,
           ce.claim_evidence_id,
           art.content_type,
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
    WHERE ea.analyzer = ${analyzerId}
      AND ea.analyzer_version = ${analyzerVersion}
      AND ea.contract_version = ${contractVersion}
      AND ea.status IN ('completed','inconclusive','unsupported','unavailable','failed')
      AND ea.result IS NOT NULL
      AND ea.analyzed_at IS NOT NULL
      AND ce.source = ${CUSTOMER_DOCUMENT_INTAKE_SOURCE}
      AND NOT EXISTS (
        SELECT 1
        FROM claim_evidence v
        WHERE v.claim_id = ce.claim_id
          AND v.source = ${UPLOADED_DOCUMENT_SOURCE}
          AND v.checker = ${UPLOADED_DOCUMENT_CHECKER}
          AND v.checker_version = ${checkerVersion}
      )
    ORDER BY ea.analyzed_at, ea.analysis_id
    LIMIT 1
  `)) as unknown as readonly {
    analysis_id: string
    tenant_id: string
    artifact_id: string
    analyzer: string
    analyzer_version: string
    contract_version: string
    result: DocumentAnalysisResult
    analyzed_at: Date | string
    claim_id: string
    claim_evidence_id: string
    content_type: string
    sha256: Buffer
  }[]

  const row = rows[0]
  if (row === undefined) return null
  return {
    analysisId: row.analysis_id,
    tenantId: row.tenant_id,
    artifactId: row.artifact_id,
    analyzer: row.analyzer,
    analyzerVersion: row.analyzer_version,
    contractVersion: row.contract_version,
    result: row.result,
    analyzedAt: asDate(row.analyzed_at),
    claimId: row.claim_id,
    claimEvidenceId: row.claim_evidence_id,
    contentType: row.content_type,
    sha256: Buffer.from(row.sha256),
  }
}

const loadContext = async (
  deps: EvidenceVerificationDeps,
  candidate: VerificationCandidate,
): Promise<VerificationContext | null> =>
  withTenant(deps.db, candidate.tenantId, async (tx) => {
    const claimRows = await tx
      .select({
        claimId: t.claim.claimId,
        validationId: t.claim.validationId,
        addressId: t.claim.addressId,
      })
      .from(t.claim)
      .where(and(eq(t.claim.claimId, candidate.claimId), eq(t.claim.tenantId, candidate.tenantId)))
      .limit(1)
    const claim = claimRows[0]
    if (claim === undefined) return null

    const validationRows = await tx
      .select({
        validationId: t.validation.validationId,
        deepContext: t.validation.deepContext,
        expiresAt: t.validation.expiresAt,
      })
      .from(t.validation)
      .where(
        and(eq(t.validation.validationId, claim.validationId), eq(t.validation.tenantId, candidate.tenantId)),
      )
      .limit(1)
    const validation = validationRows[0]
    if (validation === undefined) return null

    let addressTarget: AddressComparisonTarget | null = null
    if (claim.addressId !== null) {
      const addressRows = await tx
        .select({
          cep: t.canonicalAddress.cep,
          uf: t.canonicalAddress.uf,
          logradouroNorm: t.canonicalAddress.logradouroNorm,
          numero: t.canonicalAddress.numero,
          bairroNorm: t.canonicalAddress.bairroNorm,
          municipioIbge: t.canonicalAddress.municipioIbge,
        })
        .from(t.canonicalAddress)
        .where(eq(t.canonicalAddress.addressId, claim.addressId))
        .limit(1)
      const address = addressRows[0]
      if (address !== undefined) {
        let municipioNorm: string | null = null
        if (address.municipioIbge !== null) {
          const municipioRows = await tx
            .select({ nomeNorm: t.refReceitaMunicipio.nomeNorm })
            .from(t.refReceitaMunicipio)
            .where(eq(t.refReceitaMunicipio.codigoIbge, address.municipioIbge))
            .limit(1)
          municipioNorm = municipioRows[0]?.nomeNorm ?? null
        }
        addressTarget = {
          cep: address.cep,
          uf: address.uf,
          logradouroNorm: address.logradouroNorm,
          numero: address.numero,
          bairroNorm: address.bairroNorm,
          municipioNorm,
          // `canonical_address` não persiste complemento; não inventamos um.
          complementoNorm: null,
        }
      }
    }

    const deepRegistry = registryRecordFromDeepContext(validation.deepContext ?? null)
    let holderReference: HolderReference | null = null
    if (deepRegistry !== null) {
      const cnpjBasico = deepRegistry.record.cnpjBasico
      const legalRows =
        cnpjBasico.length === 0
          ? []
          : await tx
              .select({ razaoSocial: t.refReceitaEmpresa.razaoSocial })
              .from(t.refReceitaEmpresa)
              .where(eq(t.refReceitaEmpresa.cnpjBasico, cnpjBasico))
              .limit(1)
      holderReference = {
        legalName: legalRows[0]?.razaoSocial ?? null,
        tradeName: deepRegistry.record.nomeFantasia,
      }
    }

    return {
      expiresAt: asDate(validation.expiresAt),
      addressTarget,
      holderReference,
    }
  })

const verificationDetailOf = (
  candidate: VerificationCandidate,
  verification: UploadedDocumentVerification,
): Record<string, unknown> => ({
  verification: {
    status: verification.status,
    method: verification.method,
    source: verification.source,
    document: verification.document,
    address: verification.address,
    holder: verification.holder,
    analysis_id: candidate.analysisId,
    artifact_id: candidate.artifactId,
    analyzer: { id: candidate.analyzer, version: candidate.analyzerVersion },
    contract_version: candidate.contractVersion,
    observed_at: verification.extractedAt.toISOString(),
    limitations: [...verification.limitations],
    error_codes: [...verification.errorCodes],
    comparison: {
      address: {
        compared_fields: [...verification.addressComparison.comparedFields],
        reason_codes: [...verification.addressComparison.reasonCodes],
      },
      holder: {
        reference: verification.holderComparison.reference,
        reason_codes: [...verification.holderComparison.reasonCodes],
      },
    },
  },
})

type MaterializeOutcome = 'inserted' | 'duplicate' | 'skipped'

const materialize = async (
  deps: EvidenceVerificationDeps,
  candidate: VerificationCandidate,
  now: Date,
): Promise<MaterializeOutcome> => {
  const context = await loadContext(deps, candidate)
  if (context === null) return 'skipped'

  const verification = verifyUploadedDocument({
    analysisId: candidate.analysisId,
    artifactId: candidate.artifactId,
    artifactSha256: candidate.sha256.toString('hex'),
    contentType: candidate.contentType,
    result: candidate.result,
    addressTarget: context.addressTarget,
    holderReference: context.holderReference,
  })

  const checkerVersion = uploadedDocumentCheckerVersion(candidate.analyzerVersion, candidate.contractVersion)
  const ttlSeconds = Math.max(
    0,
    Math.floor((context.expiresAt.getTime() - verification.extractedAt.getTime()) / 1000),
  )

  const inserted = await withTenant(deps.db, candidate.tenantId, async (tx: DbTx) => {
    const rows = await tx
      .insert(t.claimEvidence)
      .values({
        claimEvidenceId: randomUUID(),
        tenantId: candidate.tenantId,
        claimId: candidate.claimId,
        signalId: null,
        evidenceId: null,
        evidenceSha256: candidate.sha256,
        checker: UPLOADED_DOCUMENT_CHECKER,
        checkerVersion,
        stance: stanceForVerification(verification),
        // F1.3 não emite signal; strength/confidence ficam neutros. O detalhe
        // preserva a comparação para a política de scoring da F3.
        strength: 0,
        confidence: 0,
        source: UPLOADED_DOCUMENT_SOURCE,
        observedAt: verification.extractedAt,
        ttlSeconds,
        expiresAt: context.expiresAt,
        detail: verificationDetailOf(candidate, verification),
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ claimEvidenceId: t.claimEvidence.claimEvidenceId })
    return rows.length > 0
  })

  return inserted ? 'inserted' : 'duplicate'
}

/**
 * Processa até `batchSize` análises terminais ainda não materializadas.
 * Erros são logados sem PII e interrompem o tick; a próxima execução retenta.
 */
export const verifyEvidenceTick = async (deps: EvidenceVerificationDeps): Promise<number> => {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE
  const runAt = deps.now ?? (() => new Date())
  let processed = 0

  while (processed < batchSize) {
    const candidate = await findNext(deps)
    if (candidate === null) break

    try {
      const outcome = await materialize(deps, candidate, runAt())
      if (outcome === 'inserted') {
        deps.logger.debug(
          {
            analysis_id: candidate.analysisId,
            artifact_id: candidate.artifactId,
            claim_id: candidate.claimId,
            checker_version: uploadedDocumentCheckerVersion(
              candidate.analyzerVersion,
              candidate.contractVersion,
            ),
            reason: 'EVIDENCE_VERIFICATION_MATERIALIZED',
          },
          'evidence verification materialized',
        )
      }
      processed += 1
      if (outcome === 'skipped') break
    } catch (error) {
      deps.logger.error(
        {
          analysis_id: candidate.analysisId,
          artifact_id: candidate.artifactId,
          claim_id: candidate.claimId,
          reason: 'EVIDENCE_VERIFICATION_MATERIALIZATION_FAILED',
          error_name: errorNameOf(error),
        },
        'evidence verification materialization failed',
      )
      break
    }
  }

  return processed
}
