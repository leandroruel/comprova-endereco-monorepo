import { createDbPool, eq, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { runMigrations } from '@comprova/db'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { createTenant } from './fixtures.js'
import { startTestDb, TEST_APP_DB_PASSWORD } from './containers.js'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const appPool = createDbPool(db.appUrl)
const tenantA = await createTenant(adminPool.db, { name: 'tenant-a' })
const tenantB = await createTenant(adminPool.db, { name: 'tenant-b' })

afterAll(async () => {
  await adminPool.end()
  await appPool.end()
  await db.stop()
})

const insertSubject = (tenantId: string) => ({
  subjectId: randomUUID(),
  tenantId,
  docType: 'CNPJ' as const,
  docHmac: randomBytes(32),
})

describe('RLS multi-tenant isolation', () => {
  it('bloqueia insert sem contexto de tenant', async () => {
    await expect(appPool.db.insert(t.subject).values(insertSubject(tenantA))).rejects.toThrow()
  })

  it('bloqueia insert de tenant diferente do contexto', async () => {
    await expect(
      withTenant(appPool.db, tenantA, (tx) => tx.insert(t.subject).values(insertSubject(tenantB))),
    ).rejects.toThrow()
  })

  it('permite insert do proprio tenant e isola leitura entre tenants', async () => {
    const subjectA = await withTenant(appPool.db, tenantA, async (tx) => {
      const values = insertSubject(tenantA)
      await tx.insert(t.subject).values(values)
      return values.subjectId
    })
    const subjectB = await withTenant(appPool.db, tenantB, async (tx) => {
      const values = insertSubject(tenantB)
      await tx.insert(t.subject).values(values)
      return values.subjectId
    })
    expect(subjectA).not.toBe(subjectB)

    const asA = await withTenant(appPool.db, tenantA, (tx) =>
      tx.select({ subjectId: t.subject.subjectId }).from(t.subject),
    )
    const asB = await withTenant(appPool.db, tenantB, (tx) =>
      tx.select({ subjectId: t.subject.subjectId }).from(t.subject),
    )
    const noTenant = await appPool.db.select({ subjectId: t.subject.subjectId }).from(t.subject)

    expect(asA.map((r) => r.subjectId)).toEqual([subjectA])
    expect(asB.map((r) => r.subjectId)).toEqual([subjectB])
    expect(noTenant.length).toBe(0)
  })

  it('validacao de um tenant e invisivel para outro', async () => {
    const subjectA = await withTenant(appPool.db, tenantA, async (tx) => {
      const values = insertSubject(tenantA)
      await tx.insert(t.subject).values(values)
      return values.subjectId
    })
    const validationId = await withTenant(appPool.db, tenantA, async (tx) => {
      const id = randomUUID()
      await tx.insert(t.validation).values({
        validationId: id,
        tenantId: tenantA,
        subjectId: subjectA,
        mode: 'fast',
        status: 'completed',
        policyVersion: 'test-policy',
        legalBasis: 'FRAUD_PREVENTION',
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      })
      return id
    })

    const fromB = await withTenant(appPool.db, tenantB, (tx) =>
      tx
        .select({ validationId: t.validation.validationId })
        .from(t.validation)
        .where(eq(t.validation.validationId, validationId)),
    )
    expect(fromB).toHaveLength(0)

    const fromA = await withTenant(appPool.db, tenantA, (tx) =>
      tx
        .select({ validationId: t.validation.validationId })
        .from(t.validation)
        .where(eq(t.validation.validationId, validationId)),
    )
    expect(fromA).toHaveLength(1)
  })

  it('audit_log aceita eventos de sistema sem tenant mas isola leitura', async () => {
    await appPool.db.insert(t.auditLog).values({ actor: 'system', action: 'test-event' })
    await withTenant(appPool.db, tenantA, (tx) =>
      tx.insert(t.auditLog).values({
        tenantId: tenantA,
        actor: 'api-key',
        action: 'test-event-a',
      }),
    )

    const asA = await withTenant(appPool.db, tenantA, (tx) =>
      tx.select({ actor: t.auditLog.actor, action: t.auditLog.action }).from(t.auditLog),
    )
    const asB = await withTenant(appPool.db, tenantB, (tx) =>
      tx.select({ actor: t.auditLog.actor, action: t.auditLog.action }).from(t.auditLog),
    )

    expect(asA).toHaveLength(2)
    expect(asB).toHaveLength(1)
    expect(asB[0]?.action).toBe('test-event')
  })

  it('bloqueia update/delete em audit_log via grants', async () => {
    const inserted = await appPool.db
      .insert(t.auditLog)
      .values({ actor: 'system', action: 'to-delete' })
      .returning({ auditId: t.auditLog.auditId })
    const auditId = inserted[0]?.auditId
    expect(auditId).toBeDefined()
    await expect(
      appPool.db
        .update(t.auditLog)
        .set({ action: 'x' })
        .where(eq(t.auditLog.auditId, auditId as number)),
    ).rejects.toThrow()
    await expect(
      appPool.db.delete(t.auditLog).where(eq(t.auditLog.auditId, auditId as number)),
    ).rejects.toThrow()
  })
})
