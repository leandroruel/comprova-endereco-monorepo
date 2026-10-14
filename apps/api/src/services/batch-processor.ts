import { and, eq, inArray, sql } from '@comprova/db'
import { isValidDocument } from '@comprova/core'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import { runFastPath, type FastPathDeps } from './fastpath.js'

export interface BatchProcessorDeps {
  readonly adminDb: Db
  readonly fastPath: FastPathDeps
  readonly maxItemsPerTick?: number
}

interface PendingItem {
  readonly itemId: string
  readonly batchId: string
  readonly tenantId: string
  readonly docType: 'CNPJ' | 'CPF'
  readonly docDigits: string
}

const claimPendingItems = async (db: Db, limit: number): Promise<readonly PendingItem[]> =>
  db.transaction(async (tx) => {
    const rows = await tx
      .select({
        itemId: t.batchItem.itemId,
        batchId: t.batchItem.batchId,
        tenantId: t.batchItem.tenantId,
        docType: t.batchItem.docType,
        docDigits: t.batchItem.docDigits,
      })
      .from(t.batchItem)
      .where(eq(t.batchItem.status, 'pending'))
      .orderBy(t.batchItem.createdAt)
      .limit(limit)
      .for('update', { skipLocked: true })
    if (rows.length === 0) return []
    await tx
      .update(t.batchItem)
      .set({ status: 'processing' })
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
      .set({
        status: 'failed',
        errorCode: 'INVALID_DOCUMENT',
        processedAt: new Date(),
      })
      .where(eq(t.batchItem.itemId, item.itemId))
    return
  }
  try {
    const result = await runFastPath(
      { ...deps.fastPath, db: deps.adminDb },
      { tenantId: item.tenantId, apiKeyId: item.batchId },
      {
        documentType: item.docType,
        documentValue: item.docDigits,
        addressInput: null,
        legalBasis: 'FRAUD_PREVENTION',
        mode: 'fast',
        idempotencyKey: `batch:${item.batchId}:${item.itemId}`,
      },
    )
    await deps.adminDb
      .update(t.batchItem)
      .set({
        status: 'completed',
        validationId: result.validationId,
        processedAt: new Date(),
      })
      .where(eq(t.batchItem.itemId, item.itemId))
  } catch (err) {
    await deps.adminDb
      .update(t.batchItem)
      .set({
        status: 'failed',
        errorCode: err instanceof Error ? err.message.slice(0, 120) : 'ERROR',
        processedAt: new Date(),
      })
      .where(eq(t.batchItem.itemId, item.itemId))
  }
}

const finalizeCompletedBatches = async (db: Db): Promise<void> => {
  const done = await db
    .select({ batchId: t.batch.batchId, tenantId: t.batch.tenantId })
    .from(t.batch)
    .where(
      and(
        eq(t.batch.status, 'queued'),
        sql`NOT EXISTS (SELECT 1 FROM ${t.batchItem} WHERE ${t.batchItem.batchId} = ${t.batch.batchId} AND ${t.batchItem.status} IN ('pending','processing'))`,
      ),
    )
  await done.reduce<Promise<void>>(async (acc, row) => {
    await acc
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
  }, Promise.resolve())
}

export const batchTick = async (deps: BatchProcessorDeps): Promise<number> => {
  const limit = deps.maxItemsPerTick ?? 5
  const items = await claimPendingItems(deps.adminDb, limit)
  await items.reduce<Promise<void>>(async (acc, item) => {
    await acc
    await processItem(deps, item)
  }, Promise.resolve())
  await finalizeCompletedBatches(deps.adminDb)
  return items.length
}

export const startBatchLoop = (deps: BatchProcessorDeps, intervalMs = 1_000): (() => void) => {
  const timer = setInterval(() => {
    void batchTick(deps).catch(() => undefined)
  }, intervalMs)
  return () => clearInterval(timer)
}
