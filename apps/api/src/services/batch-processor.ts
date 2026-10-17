import { and, eq, inArray, sql } from '@comprova/db'
import { isValidDocument } from '@comprova/core'
import * as t from '@comprova/db'
import { runFastPath, type FastPathDeps, type FastPathRequest } from './fastpath.js'

export interface BatchProcessorDeps {
  readonly adminDb: Parameters<typeof runFastPath>[0]['db']
  readonly fastPath: FastPathDeps
  readonly maxItemsPerTick?: number
  readonly leaseMs?: number
}

interface PendingItem {
  readonly itemId: string
  readonly batchId: string
  readonly tenantId: string
  readonly docType: 'CNPJ' | 'CPF'
  readonly docDigits: string
  readonly legalBasis: string
  readonly mode: string
}

const claimPendingItems = async (
  db: BatchProcessorDeps['adminDb'],
  limit: number,
  leaseMs: number,
): Promise<readonly PendingItem[]> =>
  db.transaction(async (tx) => {
    const rows = await tx
      .select({
        itemId: t.batchItem.itemId,
        batchId: t.batchItem.batchId,
        tenantId: t.batchItem.tenantId,
        docType: t.batchItem.docType,
        docDigits: t.batchItem.docDigits,
        legalBasis: t.batch.legalBasis,
        mode: t.batch.mode,
      })
      .from(t.batchItem)
      .innerJoin(t.batch, eq(t.batchItem.batchId, t.batch.batchId))
      .where(
        and(
          eq(t.batchItem.status, 'pending'),
          sql`(${t.batchItem.processedAt} IS NULL OR ${t.batchItem.processedAt} < now() - interval '${sql.raw(
            String(Math.round(leaseMs / 1000)),
          )} seconds')`,
        ),
      )
      .orderBy(t.batchItem.createdAt)
      .limit(limit)
      .for('update', { skipLocked: true })
    if (rows.length === 0) return []
    await tx
      .update(t.batchItem)
      .set({ status: 'processing', processedAt: new Date() })
      .where(
        inArray(
          t.batchItem.itemId,
          rows.map((r) => r.itemId),
        ),
      )
    return rows
  })

const processItem = async (deps: BatchProcessorDeps, item: PendingItem): Promise<void> => {
  if (!isValidDocument(item.docType, item.docDigits)) {
    await deps.adminDb
      .update(t.batchItem)
      .set({ status: 'failed', errorCode: 'INVALID_DOCUMENT', processedAt: new Date() })
      .where(eq(t.batchItem.itemId, item.itemId))
    return
  }
  try {
    const req: FastPathRequest = {
      documentType: item.docType,
      documentValue: item.docDigits,
      addressInput: null,
      legalBasis: item.legalBasis,
      mode: 'fast',
      idempotencyKey: `batch:${item.batchId}:${item.itemId}`,
    }
    const result = await runFastPath(
      { ...deps.fastPath, db: deps.adminDb },
      { tenantId: item.tenantId, apiKeyId: null },
      req,
    )
    await deps.adminDb
      .update(t.batchItem)
      .set({
        status: 'completed',
        validationId: result.validationId,
        verdict: result.verdict,
        confidence: result.confidence,
        explanation: result.explanation,
        processedAt: new Date(),
      })
      .where(eq(t.batchItem.itemId, item.itemId))
  } catch {
    await deps.adminDb
      .update(t.batchItem)
      .set({ status: 'failed', errorCode: 'PROCESSING_ERROR', processedAt: new Date() })
      .where(eq(t.batchItem.itemId, item.itemId))
  }
}

const finalizeCompletedBatches = async (db: BatchProcessorDeps['adminDb']): Promise<void> => {
  const done = await db
    .select({ batchId: t.batch.batchId, tenantId: t.batch.tenantId })
    .from(t.batch)
    .where(
      and(
        eq(t.batch.status, 'queued'),
        sql`NOT EXISTS (SELECT 1 FROM ${t.batchItem} WHERE ${t.batchItem.batchId} = ${t.batch.batchId} AND ${t.batchItem.status} IN ('pending','processing'))`,
      ),
    )
  for (const row of done) {
    const now = new Date()
    await db
      .update(t.batch)
      .set({ status: 'completed', completedAt: now })
      .where(eq(t.batch.batchId, row.batchId))
    await db.insert(t.outbox).values({
      aggregate: 'batch',
      aggregateId: row.batchId,
      eventType: 'batch.completed',
      payload: { tenant_id: row.tenantId, batch_id: row.batchId },
    })
  }
}

export const batchTick = async (deps: BatchProcessorDeps): Promise<number> => {
  const limit = deps.maxItemsPerTick ?? 5
  const leaseMs = deps.leaseMs ?? 60_000
  const items = await claimPendingItems(deps.adminDb, limit, leaseMs)
  for (const item of items) {
    await processItem(deps, item)
  }
  await finalizeCompletedBatches(deps.adminDb)
  return items.length
}

export const startBatchLoop = (deps: BatchProcessorDeps, intervalMs = 1_000): (() => void) => {
  const timer = setInterval(() => {
    void batchTick(deps).catch(() => undefined)
  }, intervalMs)
  return () => clearInterval(timer)
}
