import type { Db } from '@comprova/db'
import type { ObjectStore } from '@comprova/providers'
import { retentionTick } from './modules/evidence/evidence-retention.service.js'
import { validationRetentionTick } from './modules/retention/retention.service.js'
import { ensurePartitions } from './modules/partitions/partitions.service.js'

const DAY_MS = 86_400_000

const startLoop = (tick: () => Promise<unknown>, intervalMs: number): (() => void) => {
  const timer = setInterval(() => {
    void tick().catch(() => undefined)
  }, intervalMs)
  return () => clearInterval(timer)
}

export const startEvidenceRetentionLoop = (db: Db, store: ObjectStore, intervalMs = DAY_MS): (() => void) =>
  startLoop(() => retentionTick(db, store), intervalMs)

export const startValidationRetentionLoop = (db: Db, intervalMs = DAY_MS): (() => void) =>
  startLoop(() => validationRetentionTick(db), intervalMs)

export const startPartitionLoop = (db: Db, intervalMs = DAY_MS): (() => void) =>
  startLoop(() => ensurePartitions(db), intervalMs)
