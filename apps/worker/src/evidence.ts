import { lte, eq, inArray, sql } from '@comprova/db'
import { randomUUID } from 'node:crypto'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import type { ObjectStore } from '@comprova/providers'

export const retentionTick = async (db: Db, store: ObjectStore): Promise<number> => {
  const now = new Date()

  const expiredEvidence = await db
    .select({ evidenceId: t.evidence.evidenceId, s3Uri: t.evidence.s3Uri })
    .from(t.evidence)
    .where(lte(t.evidence.retentionUntil, now))
    .limit(500)
  for (const row of expiredEvidence) {
    const key = row.s3Uri.split('/').slice(-2).join('/')
    if (key.length > 0) {
      await store.delete(key).catch(() => undefined)
    }
    await db.delete(t.evidence).where(eq(t.evidence.evidenceId, row.evidenceId))
  }

  const expiredValidations = await db
    .select({ validationId: t.validation.validationId })
    .from(t.validation)
    .where(lte(t.validation.expiresAt, now))
    .limit(500)
  if (expiredValidations.length > 0) {
    const ids = expiredValidations.map((v) => v.validationId)
    await db.delete(t.signal).where(inArray(t.signal.validationId, ids))
    await db.delete(t.validationIdempotency).where(inArray(t.validationIdempotency.validationId, ids))
    await db.delete(t.validation).where(inArray(t.validation.validationId, ids))
  }

  await db.execute(sql`
    DELETE FROM outbox
    WHERE published_at IS NOT NULL
      AND created_at < now() - interval '7 days'
  `)

  await db.execute(sql`
    DELETE FROM webhook_delivery
    WHERE status IN ('delivered', 'failed')
      AND created_at < now() - interval '30 days'
  `)

  await db
    .execute(
      sql`
    UPDATE batch_item
    SET doc_digits = encode(digest(doc_digits, 'sha256'), 'hex')
    WHERE doc_digits !~ '^[0-9a-f]{64}$'
  `,
    )
    .catch(() => undefined)

  return expiredEvidence.length + expiredValidations.length
}

export const startRetentionLoop = (db: Db, store: ObjectStore, intervalMs = 86_400_000): (() => void) => {
  const timer = setInterval(() => {
    void retentionTick(db, store).catch(() => undefined)
  }, intervalMs)
  return () => clearInterval(timer)
}

export type EvidenceWriter = (evidence: {
  readonly kind: 'street_view_image' | 'vlm_output'
  readonly provider: string
  readonly data: Uint8Array
  readonly contentType: string
  readonly capturedAt: Date | null
  readonly retentionDays: number
  readonly detail: Record<string, unknown>
}) => Promise<string>

export const makeEvidenceWriter = (db: Db, store: ObjectStore): EvidenceWriter => {
  return async (evidence) => {
    const evidenceId = randomUUID()
    const stored = await store.put(`evidence/${evidenceId}`, evidence.data, evidence.contentType)
    await db.insert(t.evidence).values({
      evidenceId,
      kind: evidence.kind,
      provider: evidence.provider,
      s3Uri: stored.uri,
      sha256: stored.sha256,
      capturedAt: evidence.capturedAt,
      retentionUntil: new Date(Date.now() + evidence.retentionDays * 86_400_000),
    })
    return evidenceId
  }
}
