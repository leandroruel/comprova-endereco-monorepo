import type { Db } from '@comprova/db'
import type { DocumentAnalysisResult } from '@comprova/core'
import { and, eq, sql, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import type { Logger } from '@comprova/observability'
import {
  documentAnalysisFailedResult,
  documentAnalysisResultSchema,
  documentAnalysisUnavailableResult,
  DocumentAnalyzerUnavailableError,
  sha256Of,
  type DocumentAnalyzer,
  type ObjectStoreReader,
} from '@comprova/providers'

/**
 * F1.2 — execução da análise de documento.
 *
 * O worker consome as linhas `pending` de `evidence_analysis` criadas pelo
 * intake. A linha é reivindicada com `FOR UPDATE SKIP LOCKED` e o resultado
 * terminal é persistido uma única vez (trigger/unique de
 * `evidence_analysis`): retry/replay não duplica análise e concorrência não
 * produz estado inconsistente.
 *
 * A análise NÃO atualiza `claim_evidence` nem `evidence_artifact`. Ela apenas
 * grava uma observação estruturada; o verificador F1.3/F2 decide `stance`.
 */

export interface EvidenceAnalysisDeps {
  readonly db: Db
  readonly store: ObjectStoreReader
  readonly analyzer: DocumentAnalyzer
  readonly logger: Logger
  readonly maxBytes: number
  readonly batchSize?: number
  readonly claimStaleMs?: number
  /** Execuções antes de terminalizar como `failed`. Default: 5. */
  readonly maxAttempts?: number
  readonly now?: () => Date
}

interface ClaimedJob {
  readonly analysisId: string
  readonly tenantId: string
  readonly artifactId: string
  readonly attempts: number
}

interface ArtifactMetadata {
  readonly artifactId: string
  readonly storageKey: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: Buffer
}

const DEFAULT_BATCH_SIZE = 10
const DEFAULT_CLAIM_STALE_MS = 5 * 60_000
const DEFAULT_MAX_ATTEMPTS = 5

const errorNameOf = (error: unknown): string => (error instanceof Error ? error.name : 'unknown')

const claimNext = async (deps: EvidenceAnalysisDeps): Promise<ClaimedJob | null> => {
  const now = (deps.now ?? (() => new Date()))()
  const staleBefore = new Date(now.getTime() - (deps.claimStaleMs ?? DEFAULT_CLAIM_STALE_MS))
  // O driver postgres-js não serializa `Date` em parâmetros de SQL cru; use
  // ISO-8601 e deixe o Postgres inferir o cast para `timestamptz`.
  const nowIso = now.toISOString()
  const staleBeforeIso = staleBefore.toISOString()
  return deps.db.transaction(async (tx) => {
    const candidates = (await tx.execute(sql`
      SELECT analysis_id, tenant_id, artifact_id, attempts
      FROM evidence_analysis
      WHERE analyzer = ${deps.analyzer.id}
        AND analyzer_version = ${deps.analyzer.version}
        AND contract_version = ${deps.analyzer.contractVersion}
        AND (
          status = 'pending'
          OR (status = 'analyzing' AND updated_at < ${staleBeforeIso})
        )
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `)) as unknown as readonly {
      analysis_id: string
      tenant_id: string
      artifact_id: string
      attempts: number
    }[]
    const candidate = candidates[0]
    if (candidate === undefined) return null

    const updated = (await tx.execute(sql`
      UPDATE evidence_analysis
      SET status = 'analyzing',
          attempts = attempts + 1,
          updated_at = ${nowIso},
          last_error = NULL
      WHERE analysis_id = ${candidate.analysis_id}
      RETURNING analysis_id, tenant_id, artifact_id, attempts
    `)) as unknown as readonly {
      analysis_id: string
      tenant_id: string
      artifact_id: string
      attempts: number
    }[]
    const claimed = updated[0]
    if (claimed === undefined) return null
    return {
      analysisId: claimed.analysis_id,
      tenantId: claimed.tenant_id,
      artifactId: claimed.artifact_id,
      attempts: claimed.attempts,
    }
  })
}

const loadArtifact = async (
  deps: EvidenceAnalysisDeps,
  job: ClaimedJob,
): Promise<ArtifactMetadata | undefined> =>
  withTenant(deps.db, job.tenantId, async (tx) => {
    const rows = await tx
      .select({
        artifactId: t.evidenceArtifact.artifactId,
        storageKey: t.evidenceArtifact.storageKey,
        contentType: t.evidenceArtifact.contentType,
        sizeBytes: t.evidenceArtifact.sizeBytes,
        sha256: t.evidenceArtifact.sha256,
      })
      .from(t.evidenceArtifact)
      .where(
        and(eq(t.evidenceArtifact.artifactId, job.artifactId), eq(t.evidenceArtifact.tenantId, job.tenantId)),
      )
      .limit(1)
    return rows[0]
  })

const recordLastError = async (deps: EvidenceAnalysisDeps, job: ClaimedJob, reason: string): Promise<void> =>
  withTenant(deps.db, job.tenantId, async (tx) => {
    await tx
      .update(t.evidenceAnalysis)
      .set({ lastError: reason })
      .where(
        and(eq(t.evidenceAnalysis.analysisId, job.analysisId), eq(t.evidenceAnalysis.tenantId, job.tenantId)),
      )
  })

const persistResult = async (
  deps: EvidenceAnalysisDeps,
  job: ClaimedJob,
  result: DocumentAnalysisResult,
  lastError: string | null = null,
): Promise<void> =>
  withTenant(deps.db, job.tenantId, async (tx) => {
    await tx
      .update(t.evidenceAnalysis)
      .set({
        status: result.status,
        result,
        errorCodes: [...result.errorCodes],
        attempts: job.attempts,
        lastError,
        updatedAt: (deps.now ?? (() => new Date()))(),
        analyzedAt: new Date(result.analyzedAt),
      })
      .where(
        and(eq(t.evidenceAnalysis.analysisId, job.analysisId), eq(t.evidenceAnalysis.tenantId, job.tenantId)),
      )
  })

const analyzeJob = async (deps: EvidenceAnalysisDeps, job: ClaimedJob): Promise<void> => {
  const runAt = deps.now ?? (() => new Date())
  const artifact = await loadArtifact(deps, job)
  if (artifact === undefined) {
    await persistResult(deps, job, documentAnalysisUnavailableResult(runAt(), 'ARTIFACT_NOT_FOUND'))
    return
  }

  if (artifact.sizeBytes > deps.maxBytes) {
    await persistResult(deps, job, documentAnalysisUnavailableResult(runAt(), 'ANALYSIS_TOO_LARGE'))
    return
  }

  let data: Uint8Array | null
  try {
    data = await deps.store.get(artifact.storageKey)
  } catch (error) {
    deps.logger.warn(
      {
        analysis_id: job.analysisId,
        artifact_id: job.artifactId,
        reason: 'ANALYSIS_OBJECT_READ_FAILED',
        error_name: errorNameOf(error),
      },
      'evidence analysis object read failed',
    )
    // Falha transitória: a linha continua `analyzing` e é reivindicada de novo
    // após `claimStaleMs`. O cap de tentativas em `analyzeEvidenceTick` impede
    // retry indefinido e terminaliza como `failed`.
    await recordLastError(deps, job, 'OBJECT_UNAVAILABLE')
    return
  }
  if (data === null) {
    await persistResult(deps, job, documentAnalysisUnavailableResult(runAt(), 'OBJECT_NOT_FOUND'))
    return
  }
  if (data.byteLength > deps.maxBytes) {
    await persistResult(deps, job, documentAnalysisUnavailableResult(runAt(), 'ANALYSIS_TOO_LARGE'))
    return
  }

  const digest = sha256Of(data)
  if (!digest.equals(artifact.sha256)) {
    await persistResult(deps, job, documentAnalysisFailedResult(runAt(), 'ARTIFACT_HASH_MISMATCH'))
    return
  }

  let result: DocumentAnalysisResult
  try {
    result = await deps.analyzer.analyze({ data, contentType: artifact.contentType })
  } catch (error) {
    if (error instanceof DocumentAnalyzerUnavailableError) {
      await persistResult(
        deps,
        job,
        documentAnalysisUnavailableResult(runAt(), error.reason || 'ANALYZER_UNAVAILABLE'),
      )
      return
    }
    deps.logger.error(
      {
        analysis_id: job.analysisId,
        artifact_id: job.artifactId,
        reason: 'ANALYSIS_FAILED',
        error_name: errorNameOf(error),
      },
      'evidence analysis failed',
    )
    await persistResult(deps, job, documentAnalysisFailedResult(runAt(), 'ANALYZER_FAILED'))
    return
  }

  let validated: DocumentAnalysisResult
  try {
    validated = documentAnalysisResultSchema.parse(result)
  } catch (error) {
    // O analisador é uma fronteira de confiança: uma saída que não respeita o
    // schema não pode deixar a linha presa em `analyzing` para sempre.
    deps.logger.error(
      {
        analysis_id: job.analysisId,
        artifact_id: job.artifactId,
        reason: 'INVALID_ANALYZER_OUTPUT',
        error_name: errorNameOf(error),
      },
      'evidence analyzer returned an invalid result',
    )
    await persistResult(deps, job, documentAnalysisFailedResult(runAt(), 'INVALID_ANALYZER_OUTPUT'))
    return
  }

  if (
    validated.contractVersion !== deps.analyzer.contractVersion ||
    validated.analyzer.id !== deps.analyzer.id ||
    validated.analyzer.version !== deps.analyzer.version
  ) {
    deps.logger.error(
      {
        analysis_id: job.analysisId,
        artifact_id: job.artifactId,
        reason: 'INVALID_ANALYZER_IDENTITY',
      },
      'evidence analyzer returned a mismatched contract/version identity',
    )
    await persistResult(deps, job, documentAnalysisFailedResult(runAt(), 'INVALID_ANALYZER_IDENTITY'))
    return
  }

  await persistResult(deps, job, validated)
}

/**
 * Processa até `batchSize` análises pendentes de UMA versão do analisador.
 * Retorna quantas linhas foram processadas. Erros de uma linha não impedem as
 * demais: a linha permanece `analyzing` e é reivindicada novamente após
 * `claimStaleMs`.
 */
export const analyzeEvidenceTick = async (deps: EvidenceAnalysisDeps): Promise<number> => {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const runAt = deps.now ?? (() => new Date())
  let processed = 0
  while (processed < batchSize) {
    const job = await claimNext(deps)
    if (job === null) break
    try {
      if (job.attempts > maxAttempts) {
        deps.logger.warn(
          {
            analysis_id: job.analysisId,
            artifact_id: job.artifactId,
            attempts: job.attempts,
            reason: 'ANALYSIS_ATTEMPTS_EXCEEDED',
          },
          'evidence analysis attempts exceeded; terminalizing',
        )
        await persistResult(
          deps,
          job,
          documentAnalysisFailedResult(runAt(), 'ANALYSIS_ATTEMPTS_EXCEEDED'),
          'ANALYSIS_ATTEMPTS_EXCEEDED',
        )
      } else {
        await analyzeJob(deps, job)
      }
    } catch (error) {
      deps.logger.error(
        {
          analysis_id: job.analysisId,
          artifact_id: job.artifactId,
          reason: 'ANALYSIS_TICK_ITEM_FAILED',
          error_name: errorNameOf(error),
        },
        'evidence analysis item failed; will retry after stale timeout',
      )
    }
    processed += 1
  }
  return processed
}
