import { inArray, lte, sql } from '@comprova/db'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import { mapSequential } from '@comprova/core'
import type { ObjectStore } from '@comprova/providers'

/**
 * ALTO-2: retenção de material robusta a crash/retry.
 * Ordem: (1) transição de estado no banco -> (2) remoção do objeto físico ->
 * (3) limpeza final no banco. Nunca removemos o objeto antes de garantir que
 * nenhuma referência aponta para ele.
 */
const removeExpiredEvidence = async (db: Db, store: ObjectStore): Promise<number> => {
  const expiredEvidence = await db
    .select({ evidenceId: t.evidence.evidenceId, s3Uri: t.evidence.s3Uri })
    .from(t.evidence)
    .where(lte(t.evidence.retentionUntil, new Date()))
    .limit(500)

  if (expiredEvidence.length === 0) return 0

  const evidenceIds = expiredEvidence.map((row) => row.evidenceId)

  // (1) DB state transition: `claim_evidence` é o histórico da observação e
  // permanece; apenas o ponteiro opcional para o artefato material é anulado.
  // O mesmo para `signal` e `address_signal_cache` (ambos sem FK para evidence).
  await db
    .update(t.claimEvidence)
    .set({ evidenceId: null })
    .where(inArray(t.claimEvidence.evidenceId, evidenceIds))
  await db.update(t.signal).set({ evidenceId: null }).where(inArray(t.signal.evidenceId, evidenceIds))
  await db
    .update(t.addressSignalCache)
    .set({ evidenceId: null })
    .where(inArray(t.addressSignalCache.evidenceId, evidenceIds))

  // (2) Storage: remover o objeto físico (idempotente; ausência não é erro).
  await mapSequential(expiredEvidence, async (row) => {
    const key = row.s3Uri.split('/').slice(-2).join('/')
    if (key.length > 0) await store.delete(key).catch(() => undefined)
  })

  // (3) DB cleanup: nenhuma FK/ponteiro referencia mais o material.
  const deleted = await db
    .delete(t.evidence)
    .where(inArray(t.evidence.evidenceId, evidenceIds))
    .returning({ evidenceId: t.evidence.evidenceId })
  return deleted.length
}

const pruneRetentionTables = async (db: Db): Promise<void> => {
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
}

export const retentionTick = async (db: Db, store: ObjectStore): Promise<number> => {
  const removedEvidence = await removeExpiredEvidence(db, store)
  await pruneRetentionTables(db)
  return removedEvidence
}
