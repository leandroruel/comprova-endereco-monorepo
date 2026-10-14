import { eq, lte } from '@comprova/db'
import type { ObjectStore } from '@comprova/providers'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import { randomUUID } from 'node:crypto'
import type { EvidenceWriter } from '@comprova/checkers'

export const makeEvidenceWriter = (db: Db, store: ObjectStore): EvidenceWriter => {
  return async (evidence) => {
    const evidenceId = randomUUID()
    const stored = await store.put(`evidence/${evidenceId}`, evidence.data, evidence.contentType)
    const retentionUntil = new Date(Date.now() + evidence.retentionDays * 86_400_000)
    await db.insert(t.evidence).values({
      evidenceId,
      kind: evidence.kind,
      provider: evidence.provider,
      s3Uri: stored.uri,
      sha256: stored.sha256,
      capturedAt: evidence.capturedAt,
      retentionUntil,
    })
    return evidenceId
  }
}

const keyFromUri = (uri: string): string | null => {
  const marker = '/evidence/'
  const idx = uri.indexOf(marker)
  return idx === -1 ? null : `evidence/${uri.slice(idx + marker.length)}`
}

export const retentionTick = async (db: Db, store: ObjectStore): Promise<number> => {
  const now = new Date()
  const expired = await db
    .select({
      evidenceId: t.evidence.evidenceId,
      s3Uri: t.evidence.s3Uri,
    })
    .from(t.evidence)
    .where(lte(t.evidence.retentionUntil, now))
    .limit(100)
  await expired.reduce<Promise<void>>(async (acc, row) => {
    await acc
    const key = keyFromUri(row.s3Uri)
    if (key !== null) {
      await store.delete(key).catch(() => undefined)
    }
    await db.delete(t.evidence).where(eq(t.evidence.evidenceId, row.evidenceId))
  }, Promise.resolve())
  return expired.length
}

export const startRetentionLoop = (db: Db, store: ObjectStore, intervalMs = 3_600_000): (() => void) => {
  const timer = setInterval(() => {
    void retentionTick(db, store).catch(() => undefined)
  }, intervalMs)
  return () => clearInterval(timer)
}
