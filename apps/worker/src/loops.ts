import type { Db } from '@comprova/db'
import type { Logger } from '@comprova/observability'
import type { DocumentAnalyzer, ObjectStore, ObjectStoreReader } from '@comprova/providers'
import { retentionTick } from './modules/evidence/evidence-retention.service.js'
import { analyzeEvidenceTick } from './modules/evidence-analysis/evidence-analysis.service.js'
import { verifyEvidenceTick } from './modules/evidence-verification/evidence-verification.service.js'
import { validationRetentionTick } from './modules/retention/retention.service.js'
import { ensurePartitions } from './modules/partitions/partitions.service.js'

const DAY_MS = 86_400_000

const startLoop = (tick: () => Promise<unknown>, intervalMs: number, logger?: Logger): (() => void) => {
  const timer = setInterval(() => {
    void tick().catch((error: unknown) => {
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
export const startEvidenceVerificationLoop = (db: Db, logger: Logger, intervalMs = 2_000): (() => void) => {
  let running = false
  return startLoop(
    async () => {
      if (running) return
      running = true
      try {
        await verifyEvidenceTick({ db, logger })
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
