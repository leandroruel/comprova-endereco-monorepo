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
  type UploadedDocumentVerification,
} from '@comprova/core'
import { sql, withTenant } from '@comprova/db'
import type { Db, DbTx } from '@comprova/db'
import * as t from '@comprova/db'
import type { Logger } from '@comprova/observability'
import { randomUUID } from 'node:crypto'
import { loadClaimVerificationContext } from './claim-context.js'

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

const DEFAULT_BATCH_SIZE = 20
const ATTEMPT_BACKOFF_BASE_SECONDS = 60
const ATTEMPT_BACKOFF_MAX_SECONDS = 3600
const ATTEMPT_BACKOFF_EXPONENT_CAP = 10
const CONTEXT_MISSING_CODE = 'CONTEXT_MISSING'

const errorNameOf = (error: unknown): string => (error instanceof Error ? error.name : 'unknown')

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value))

const versionsOf = (deps: EvidenceVerificationDeps) => ({
  analyzerId: deps.analyzerId ?? DOCUMENT_ANALYZER_ID,
  analyzerVersion: deps.analyzerVersion ?? DOCUMENT_ANALYZER_VERSION,
  contractVersion: deps.contractVersion ?? DOCUMENT_ANALYSIS_CONTRACT_VERSION,
})

const findNext = async (
  deps: EvidenceVerificationDeps,
  excluded: ReadonlySet<string>,
): Promise<VerificationCandidate | null> => {
  const { analyzerId, analyzerVersion, contractVersion } = versionsOf(deps)
  const checkerVersion = uploadedDocumentCheckerVersion(analyzerVersion, contractVersion)
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
    LEFT JOIN evidence_verification_attempt eva
      ON eva.analysis_id = ea.analysis_id
     AND eva.tenant_id = ea.tenant_id
    WHERE ea.analyzer = ${analyzerId}
      AND ea.analyzer_version = ${analyzerVersion}
      AND ea.contract_version = ${contractVersion}
      AND ea.status IN ('completed','inconclusive','unsupported','unavailable','failed')
      AND ea.result IS NOT NULL
      AND ea.analyzed_at IS NOT NULL
      AND ce.source = ${CUSTOMER_DOCUMENT_INTAKE_SOURCE}
      AND (eva.next_attempt_at IS NULL OR eva.next_attempt_at <= now())
      AND NOT EXISTS (
        SELECT 1
        FROM claim_evidence v
        WHERE v.claim_id = ce.claim_id
          AND v.source = ${UPLOADED_DOCUMENT_SOURCE}
          AND v.checker = ${UPLOADED_DOCUMENT_CHECKER}
          AND v.checker_version = ${checkerVersion}
      )
      ${excludedClause}
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

const loadContext = async (deps: EvidenceVerificationDeps, candidate: VerificationCandidate) =>
  loadClaimVerificationContext(deps.db, candidate.tenantId, candidate.claimId)

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
 * Persiste o backoff exponencial de uma tentativa que falhou ou ficou sem
 * contexto. O estado é administrativo (sem PII) e a próxima tentativa fica no
 * futuro, para que o candidate mais antigo não monopolize todos os ticks.
 *
 * Exportada para o tick fiscal (F2.2b→F3) reutilizar o mesmo estado de retry
 * por `analysis_id`: os dois consumidores nunca disputam a mesma linha (o
 * tick fiscal só roda depois da verificação F1.3 materializar).
 */
export interface VerificationAttemptKey {
  readonly analysisId: string
  readonly tenantId: string
}

export const recordVerificationAttempt = async (
  db: Db,
  key: VerificationAttemptKey,
  errorCode: string,
): Promise<void> => {
  await db.execute(sql`
    INSERT INTO evidence_verification_attempt
      (analysis_id, tenant_id, attempts, last_attempt_at, next_attempt_at, last_error_code)
    VALUES (
      ${key.analysisId},
      ${key.tenantId},
      1,
      now(),
      now() + make_interval(secs => ${ATTEMPT_BACKOFF_BASE_SECONDS}::double precision),
      ${errorCode}
    )
    ON CONFLICT (analysis_id) DO UPDATE
    SET attempts = evidence_verification_attempt.attempts + 1,
        last_attempt_at = now(),
        next_attempt_at = now() + make_interval(
          secs => LEAST(
            ${ATTEMPT_BACKOFF_MAX_SECONDS}::double precision,
            ${ATTEMPT_BACKOFF_BASE_SECONDS}::double precision * POWER(
              2::double precision,
              LEAST(
                evidence_verification_attempt.attempts,
                ${ATTEMPT_BACKOFF_EXPONENT_CAP}
              )::double precision
            )
          )
        ),
        last_error_code = EXCLUDED.last_error_code
  `)
}

export const clearVerificationAttempt = async (db: Db, key: VerificationAttemptKey): Promise<void> => {
  await db.execute(sql`
    DELETE FROM evidence_verification_attempt
    WHERE analysis_id = ${key.analysisId}
      AND tenant_id = ${key.tenantId}
  `)
}

const recordAttempt = (deps: EvidenceVerificationDeps, candidate: VerificationCandidate, errorCode: string) =>
  recordVerificationAttempt(deps.db, candidate, errorCode)

const clearAttempt = (deps: EvidenceVerificationDeps, candidate: VerificationCandidate) =>
  clearVerificationAttempt(deps.db, candidate)

/**
 * Processa até `batchSize` análises terminais ainda não materializadas.
 * Candidatos que falham ou ficam sem contexto são excluídos do restante do tick
 * e recebem backoff persistente; assim um tenant não bloqueia os demais. Erros
 * continuam sendo logados sem PII.
 */
export const verifyEvidenceTick = async (deps: EvidenceVerificationDeps): Promise<number> => {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE
  const runAt = deps.now ?? (() => new Date())
  const excluded = new Set<string>()
  let processed = 0

  while (processed < batchSize) {
    const candidate = await findNext(deps, excluded)
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
      if (outcome === 'skipped') {
        await recordAttempt(deps, candidate, CONTEXT_MISSING_CODE)
        excluded.add(candidate.analysisId)
      } else {
        await clearAttempt(deps, candidate)
      }
      processed += 1
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
      try {
        await recordAttempt(deps, candidate, errorNameOf(error))
      } catch (attemptError) {
        deps.logger.error(
          {
            analysis_id: candidate.analysisId,
            artifact_id: candidate.artifactId,
            claim_id: candidate.claimId,
            reason: 'EVIDENCE_VERIFICATION_ATTEMPT_RECORD_FAILED',
            error_name: errorNameOf(attemptError),
          },
          'evidence verification attempt record failed',
        )
      }
      excluded.add(candidate.analysisId)
      processed += 1
    }
  }

  return processed
}
