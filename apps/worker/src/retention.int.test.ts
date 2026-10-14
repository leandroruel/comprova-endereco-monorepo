import {
  createTenant,
  createSubject,
  createValidation,
  startTestDb,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import { createDbPool, eq, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import { afterAll, describe, expect, it } from 'vitest'
import { validationRetentionTick } from './retention.js'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const tenant = await createTenant(adminPool.db, { name: 'ret-tenant' })

afterAll(async () => {
  await adminPool.end()
  await db.stop()
})

describe('retention de validacoes (expires_at)', () => {
  it('remove validacoes expiradas com sinais e idempotencia, mantem vigentes', async () => {
    const subject = await createSubject(adminPool.db, tenant)

    const expired = await createValidation(adminPool.db, tenant, subject)
    await adminPool.db
      .update(t.validation)
      .set({ expiresAt: new Date(Date.now() - 86_400_000) })
      .where(eq(t.validation.validationId, expired))
    await adminPool.db.insert(t.signal).values({
      signalId: crypto.randomUUID(),
      validationId: expired,
      checkerId: 'document_integrity',
      checkerVersion: '1.0.0',
      stance: 'supports',
      strength: 0.5,
      confidence: 1,
      source: 'test',
      observedAt: new Date(),
      ttlSeconds: 3600,
      detail: {},
    })
    await adminPool.db.insert(t.validationIdempotency).values({
      tenantId: tenant,
      idempotencyKey: 'retention-expired-key',
      validationId: expired,
    })

    const fresh = await createValidation(adminPool.db, tenant, subject)
    await adminPool.db.insert(t.validationIdempotency).values({
      tenantId: tenant,
      idempotencyKey: 'retention-fresh-key',
      validationId: fresh,
    })

    const removed = await validationRetentionTick(adminPool.db)
    expect(removed).toBeGreaterThanOrEqual(1)

    const goneSignals = await adminPool.db.select().from(t.signal).where(eq(t.signal.validationId, expired))
    expect(goneSignals.length).toBe(0)

    const stillFresh = await adminPool.db
      .select({ validationId: t.validation.validationId })
      .from(t.validation)
      .where(eq(t.validation.validationId, fresh))
    expect(stillFresh.length).toBe(1)

    const audit = await adminPool.db
      .select()
      .from(t.auditLog)
      .where(eq(t.auditLog.action, 'validation.expired'))
    expect(audit.length).toBeGreaterThanOrEqual(1)
  })
})
