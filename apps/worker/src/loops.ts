import type { FiscalAdapter } from '@comprova/core'
import type { Db } from '@comprova/db'
import type { Logger } from '@comprova/observability'
import type { DocumentAnalyzer, ObjectStore, ObjectStoreReader } from '@comprova/providers'
import { retentionTick } from './modules/evidence/evidence-retention.service.js'
import { analyzeEvidenceTick } from './modules/evidence-analysis/evidence-analysis.service.js'
import { verifyEvidenceTick } from './modules/evidence-verification/evidence-verification.service.js'
import { verifyFiscalTick } from './modules/fiscal-verification/fiscal-verification.tick.js'
import { holderSubmissionProcessingTick } from './modules/holder-submission-processing/holder-submission-processing.service.js'
import { validationRetentionTick } from './modules/retention/retention.service.js'
import { ensurePartitions } from './modules/partitions/partitions.service.js'

const DAY_MS = 86_400_000

const startLoop = (tick: () => Promise<unknown>, intervalMs: number, logger?: Logger): (() => void) => {
  const timer = setInterval(() => {
    tick().catch((error: unknown) => {
      logger?.error(
        {
          reason: 'WORKER_LOOP_TICK_FAILED',
          error_name: error instanceof Error ? error.name : 'unknown',
          error_message: error instanceof Error ? error.message : String(error),
        },
        'worker loop tick failed',
      )
    })
  }, intervalMs)
  return () => clearInterval(timer)
}

export const startEvidenceRetentionLoop = (
  db: Db,
  store: ObjectStore,
  logger?: Logger,
  intervalMs = DAY_MS,
): (() => void) => startLoop(() => retentionTick(db, store), intervalMs, logger)

export const startValidationRetentionLoop = (
  db: Db,
  store: ObjectStore,
  logger?: Logger,
  intervalMs = DAY_MS,
): (() => void) => startLoop(() => validationRetentionTick(db, store, 200, logger), intervalMs, logger)

/**
 * F1.2: consome as linhas `pending` de `evidence_analysis` criadas pelo intake.
 * Roda no pool de manutenção (admin) porque atravessa tenants; cada item é
 * processado com `withTenant`, então a RLS continua valendo no acesso ao
 * artefato. O loop é curto (2s) e não depende de Redis/Temporal.
 */
export const startEvidenceAnalysisLoop = (
  db: Db,
  store: ObjectStoreReader,
  analyzer: DocumentAnalyzer,
  maxBytes: number,
  logger: Logger,
  intervalMs = 2_000,
): (() => void) => {
  let running = false
  return startLoop(
    async () => {
      if (running) return
      running = true
      try {
        await analyzeEvidenceTick({ db, store, analyzer, maxBytes, logger })
      } finally {
        running = false
      }
    },
    intervalMs,
    logger,
  )
}

/**
 * F1.3: consome análises terminais e materializa a verificação em
 * `claim_evidence`. Também atravessa tenants (fila global) e usa o pool de
 * manutenção; o acesso aos dados do claim é feito com `withTenant`. Não emite
 * signal e, portanto, não altera o score.
 */
export const startEvidenceVerificationLoop = (
  db: Db,
  logger: Logger,
  referenceDb?: Db,
  intervalMs = 2_000,
): (() => void) => {
  let running = false
  return startLoop(
    async () => {
      if (running) return
      running = true
      try {
        await verifyEvidenceTick({ db, logger, ...(referenceDb !== undefined ? { referenceDb } : {}) })
      } finally {
        running = false
      }
    },
    intervalMs,
    logger,
  )
}

/**
 * F2.2b/F3: consome as referências fiscais extraídas do comprovante (F1.2),
 * consulta o autorizador (adapter NF3e) e reavalia o claim. Atravessa tenants
 * (fila global no pool de manutenção); a consulta e a reavaliação usam
 * `withTenant`. A reavaliação roda no pool do app/RLS passado pelo caller.
 */
export const startFiscalVerificationLoop = (
  db: Db,
  adapter: FiscalAdapter,
  reassess: (tenantId: string, validationId: string) => Promise<unknown>,
  logger: Logger,
  referenceDb?: Db,
  intervalMs = 2_000,
): (() => void) => {
  let running = false
  return startLoop(
    async () => {
      if (running) return
      running = true
      try {
        await verifyFiscalTick({
          db,
          adapter,
          reassess,
          logger,
          ...(referenceDb !== undefined ? { referenceDb } : {}),
        })
      } finally {
        running = false
      }
    },
    intervalMs,
    logger,
  )
}

/**
 * F4.3: consome eventos de outbox `holder_submission.processing_requested` e
 * executa o processamento documental (criação de evidence_artifact +
 * evidence_analysis) para cada submissão concluída pelo Holder. Atravessa
 * tenants (fila global no pool de manutenção); o acesso aos documentos é feito
 * com `withTenant`.
 */
export const startHolderSubmissionProcessingLoop = (
  db: Db,
  store: ObjectStoreReader,
  logger: Logger,
  intervalMs = 2_000,
): (() => void) => {
  let running = false
  return startLoop(
    async () => {
      if (running) return
      running = true
      try {
        await holderSubmissionProcessingTick({ db, store, logger })
      } finally {
        running = false
      }
    },
    intervalMs,
    logger,
  )
}

export const startPartitionLoop = (db: Db, intervalMs = DAY_MS): (() => void) =>
  startLoop(() => ensurePartitions(db), intervalMs)
