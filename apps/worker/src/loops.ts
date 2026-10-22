import type { Db } from '@comprova/db'
import type { Logger } from '@comprova/observability'
import type { ObjectStore } from '@comprova/providers'
import { retentionTick } from './modules/evidence/evidence-retention.service.js'
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

export const startPartitionLoop = (db: Db, intervalMs = DAY_MS): (() => void) =>
  startLoop(() => ensurePartitions(db), intervalMs)
