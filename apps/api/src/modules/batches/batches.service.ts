import { and, desc, eq, withTenant } from '@comprova/db'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import { digitsOnly } from '@comprova/core'
import { randomUUID } from 'node:crypto'
import type { CreateBatchBody } from './batches.schema.js'

export const createBatch = async (
  db: Db,
  tenantId: string,
  userId: string | null,
  body: CreateBatchBody,
): Promise<{ readonly batchId: string; readonly totalItems: number }> => {
  const batchId = randomUUID()
  const items = body.documents.map((item, position) => ({
    itemId: randomUUID(),
    batchId,
    tenantId,
    position,
    docType: item.type,
    docDigits: digitsOnly(item.value),
    status: 'pending',
  }))

  await withTenant(db, tenantId, async (tx) => {
    await tx.insert(t.batch).values({
      batchId,
      tenantId,
      userId,
      status: 'queued',
      totalItems: items.length,
      mode: body.mode,
      legalBasis: body.legal_basis,
    })
    await tx.insert(t.batchItem).values(items)
  })

  return { batchId, totalItems: items.length }
}

export const listBatches = async (db: Db, tenantId: string, userId: string | undefined) => {
  const batches = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        batchId: t.batch.batchId,
        status: t.batch.status,
        totalItems: t.batch.totalItems,
        createdAt: t.batch.createdAt,
        completedAt: t.batch.completedAt,
      })
      .from(t.batch)
      .where(userId !== null && userId !== undefined ? eq(t.batch.userId, userId) : undefined)
      .orderBy(desc(t.batch.createdAt))
      .limit(20),
  )

  const batchIds = batches.map((batch) => batch.batchId)
  const items =
    batchIds.length > 0
      ? await withTenant(db, tenantId, (tx) =>
          tx
            .select({
              batchId: t.batchItem.batchId,
              status: t.batchItem.status,
            })
            .from(t.batchItem),
        ).then((all) => all.filter((item) => batchIds.includes(item.batchId)))
      : []

  return batches.map((batch) => ({
    batch_id: batch.batchId,
    status: batch.status,
    total_items: batch.totalItems,
    completed: items.filter((item) => item.batchId === batch.batchId && item.status === 'completed').length,
    failed: items.filter((item) => item.batchId === batch.batchId && item.status === 'failed').length,
    created_at: batch.createdAt.toISOString(),
    completed_at: batch.completedAt?.toISOString() ?? null,
  }))
}

export const getBatch = async (db: Db, tenantId: string, batchId: string) =>
  withTenant(db, tenantId, async (tx) => {
    const batchRows = await tx
      .select({
        batchId: t.batch.batchId,
        status: t.batch.status,
        totalItems: t.batch.totalItems,
      })
      .from(t.batch)
      .where(and(eq(t.batch.batchId, batchId), eq(t.batch.tenantId, tenantId)))
      .limit(1)
    const batch = batchRows[0]
    if (batch === undefined) return null

    const items = await tx
      .select({
        position: t.batchItem.position,
        docType: t.batchItem.docType,
        status: t.batchItem.status,
        validationId: t.batchItem.validationId,
        errorCode: t.batchItem.errorCode,
        verdict: t.batchItem.verdict,
        confidence: t.batchItem.confidence,
        explanation: t.batchItem.explanation,
      })
      .from(t.batchItem)
      .where(eq(t.batchItem.batchId, batch.batchId))
      .orderBy(t.batchItem.position)
    return { batch, items }
  })

export const getBatchExport = async (db: Db, tenantId: string, batchId: string) =>
  withTenant(db, tenantId, async (tx) => {
    const batches = await tx
      .select({ batchId: t.batch.batchId })
      .from(t.batch)
      .where(eq(t.batch.batchId, batchId))
      .limit(1)
    if (batches.length === 0) return null

    return tx
      .select({
        position: t.batchItem.position,
        docType: t.batchItem.docType,
        docDigits: t.batchItem.docDigits,
        status: t.batchItem.status,
        verdict: t.batchItem.verdict,
        confidence: t.batchItem.confidence,
        explanation: t.batchItem.explanation,
        errorCode: t.batchItem.errorCode,
      })
      .from(t.batchItem)
      .where(eq(t.batchItem.batchId, batchId))
      .orderBy(t.batchItem.position)
  })
