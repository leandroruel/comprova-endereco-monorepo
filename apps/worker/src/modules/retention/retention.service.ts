import { inArray, lte } from '@comprova/db'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'

interface ExpiredValidation {
  readonly validationId: string
  readonly tenantId: string
}

/**
 * ALTO-1: a retenção remove o grafo inteiro da validation como uma unidade
 * lógica, respeitando dependências:
 *   claim_evidence -> claim -> signal / validation
 * `subject` e `canonical_address` possuem ciclo de vida próprio e NÃO são
 * removidos aqui (ver ADR de retenção).
 */
const deleteValidationGraph = async (db: Db, validationIds: readonly string[]): Promise<void> => {
  const claims = await db
    .select({ claimId: t.claim.claimId })
    .from(t.claim)
    .where(inArray(t.claim.validationId, [...validationIds]))

  if (claims.length > 0) {
    await db.delete(t.claimEvidence).where(
      inArray(
        t.claimEvidence.claimId,
        claims.map((claim) => claim.claimId),
      ),
    )
    await db.delete(t.claim).where(inArray(t.claim.validationId, [...validationIds]))
  }

  await db.delete(t.signal).where(inArray(t.signal.validationId, [...validationIds]))
  await db
    .delete(t.validationIdempotency)
    .where(inArray(t.validationIdempotency.validationId, [...validationIds]))
  await db.delete(t.validation).where(inArray(t.validation.validationId, [...validationIds]))
}

const recordExpirationAudit = async (db: Db, expired: readonly ExpiredValidation[]): Promise<void> => {
  const tenants = [...new Set(expired.map((row) => row.tenantId))]
  await db.insert(t.auditLog).values(
    tenants.map((tenantId) => ({
      tenantId,
      actor: 'system:retention',
      action: 'validation.expired',
      targetType: 'validation',
      targetId: 'batch',
      details: {
        removed: expired.filter((row) => row.tenantId === tenantId).length,
      },
    })),
  )
}

export const validationRetentionTick = async (db: Db, limit = 200): Promise<number> => {
  const expired = await db
    .select({
      validationId: t.validation.validationId,
      tenantId: t.validation.tenantId,
    })
    .from(t.validation)
    .where(lte(t.validation.expiresAt, new Date()))
    .limit(limit)

  if (expired.length === 0) return 0

  await deleteValidationGraph(
    db,
    expired.map((row) => row.validationId),
  )
  await recordExpirationAudit(db, expired)
  return expired.length
}
