import { inArray, lte } from '@comprova/db'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'

export const validationRetentionTick = async (db: Db, limit = 200): Promise<number> => {
  const now = new Date()
  const expired = await db
    .select({
      validationId: t.validation.validationId,
      tenantId: t.validation.tenantId,
    })
    .from(t.validation)
    .where(lte(t.validation.expiresAt, now))
    .limit(limit)
  if (expired.length === 0) return 0

  const validationIds = expired.map((row) => row.validationId)
  await db.delete(t.signal).where(inArray(t.signal.validationId, validationIds))
  await db.delete(t.validationIdempotency).where(inArray(t.validationIdempotency.validationId, validationIds))
  await db.delete(t.validation).where(inArray(t.validation.validationId, validationIds))

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
  return expired.length
}

export const startValidationRetentionLoop = (
  db: Db,
  intervalMs = 86_400_000,
  onTick?: () => Date,
): (() => void) => {
  void onTick
  const timer = setInterval(() => {
    void validationRetentionTick(db).catch(() => undefined)
  }, intervalMs)
  return () => clearInterval(timer)
}
