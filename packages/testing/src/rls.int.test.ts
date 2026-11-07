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

  it('RLS usage_event: isola leitura e escrita entre tenants (app_user)', async () => {
    await withTenant(appPool.db, tenantA, (tx) =>
      tx.insert(t.usageEvent).values({
        eventId: randomUUID(),
        tenantId: tenantA,
        eventType: 'usage_event',
        kind: 'fast',
        units: 1,
        billable: true,
        source: 'fast',
        occurredAt: new Date(),
      }),
    )
    await withTenant(appPool.db, tenantB, (tx) =>
      tx.insert(t.usageEvent).values({
        eventId: randomUUID(),
        tenantId: tenantB,
        eventType: 'usage_event',
        kind: 'deep',
        units: 1,
        billable: false,
        source: 'deep',
        occurredAt: new Date(),
      }),
    )

    const asA = await withTenant(appPool.db, tenantA, (tx) =>
      tx.select({ eventId: t.usageEvent.eventId }).from(t.usageEvent),
    )
    const asB = await withTenant(appPool.db, tenantB, (tx) =>
      tx.select({ eventId: t.usageEvent.eventId }).from(t.usageEvent),
    )
    expect(asA.map((r) => r.eventId)).toHaveLength(1)
    expect(asB.map((r) => r.eventId)).toHaveLength(1)
  })

  it('RLS usage_event: bloqueia insert com tenant incompatível ao contexto', async () => {
    await expect(
      withTenant(appPool.db, tenantA, (tx) =>
        tx.insert(t.usageEvent).values({
          eventId: randomUUID(),
          tenantId: tenantB, // tenant diferente do contexto (tenantA)
          eventType: 'usage_event',
          kind: 'fast',
          units: 1,
          billable: true,
          source: 'fast',
          occurredAt: new Date(),
        }),
      ),
    ).rejects.toThrow()
  })

  it('RLS usage_event_idempotency: isola leitura e escrita entre tenants', async () => {
    const key = 'idem-rls-' + randomUUID()
    await withTenant(appPool.db, tenantA, (tx) =>
      tx.insert(t.usageEventIdempotency).values({
        tenantId: tenantA,
        idempotencyKey: key,
        eventId: null,
      }),
    )
    const asA = await withTenant(appPool.db, tenantA, (tx) =>
      tx.select({ idempotencyKey: t.usageEventIdempotency.idempotencyKey }).from(t.usageEventIdempotency),
    )
    const asB = await withTenant(appPool.db, tenantB, (tx) =>
      tx.select({ idempotencyKey: t.usageEventIdempotency.idempotencyKey }).from(t.usageEventIdempotency),
    )
    expect(asA.map((r) => r.idempotencyKey)).toContain(key)
    expect(asB.map((r) => r.idempotencyKey)).not.toContain(key)
  })

  it('RLS usage_billing_unit: isola leitura e escrita entre tenants e bloqueia tenant incompatível', async () => {
    const validationId = randomUUID()
    await withTenant(appPool.db, tenantA, (tx) =>
      tx.insert(t.usageBillingUnit).values({
        tenantId: tenantA,
        validationId,
        eventId: null,
      }),
    )
    const asA = await withTenant(appPool.db, tenantA, (tx) =>
      tx.select({ validationId: t.usageBillingUnit.validationId }).from(t.usageBillingUnit),
    )
    const asB = await withTenant(appPool.db, tenantB, (tx) =>
      tx.select({ validationId: t.usageBillingUnit.validationId }).from(t.usageBillingUnit),
    )
    expect(asA.map((r) => r.validationId)).toEqual([validationId])
    expect(asB).toHaveLength(0)

    await expect(
      withTenant(appPool.db, tenantA, (tx) =>
        tx.insert(t.usageBillingUnit).values({
          tenantId: tenantB, // tenant diferente do contexto (tenantA)
          validationId: randomUUID(),
          eventId: null,
        }),
      ),
    ).rejects.toThrow()
  })
})

describe('RLS Holder/KYC isolation (app_user)', () => {
  const newHolder = (tenantId: string) => ({
    holderId: randomUUID(),
    tenantId,
    externalReference: `ext-${randomUUID()}`,
    name: 'Titular Teste',
    documentHash: 'a'.repeat(64),
    documentType: 'CPF' as const,
  })

  it('consulta sem contexto de tenant não retorna holders', async () => {
    await withTenant(appPool.db, tenantA, (tx) => tx.insert(t.holder).values(newHolder(tenantA)))
    const noTenant = await appPool.db.select({ holderId: t.holder.holderId }).from(t.holder)
    expect(noTenant).toHaveLength(0)
  })

  it('bloqueia insert de holder sem contexto de tenant', async () => {
    await expect(appPool.db.insert(t.holder).values(newHolder(tenantA))).rejects.toThrow()
  })

  it('bloqueia insert de holder de tenant diferente do contexto', async () => {
    await expect(
      withTenant(appPool.db, tenantA, (tx) => tx.insert(t.holder).values(newHolder(tenantB))),
    ).rejects.toThrow()
  })

  it('tenant A acessa seus holders e não enxerga os do tenant B', async () => {
    const holderA = await withTenant(appPool.db, tenantA, async (tx) => {
      const v = newHolder(tenantA)
      await tx.insert(t.holder).values(v)
      return v.holderId
    })
    const holderB = await withTenant(appPool.db, tenantB, async (tx) => {
      const v = newHolder(tenantB)
      await tx.insert(t.holder).values(v)
      return v.holderId
    })
    expect(holderA).not.toBe(holderB)

    const asA = await withTenant(appPool.db, tenantA, (tx) =>
      tx.select({ holderId: t.holder.holderId }).from(t.holder),
    )
    const asB = await withTenant(appPool.db, tenantB, (tx) =>
      tx.select({ holderId: t.holder.holderId }).from(t.holder),
    )

    expect(asA.map((r) => r.holderId)).toContain(holderA)
    expect(asA.map((r) => r.holderId)).not.toContain(holderB)
    expect(asB.map((r) => r.holderId)).toContain(holderB)
    expect(asB.map((r) => r.holderId)).not.toContain(holderA)
  })

  it('tenant A não atualiza nem exclui holder do tenant B', async () => {
    const holderB = await withTenant(appPool.db, tenantB, async (tx) => {
      const v = newHolder(tenantB)
      await tx.insert(t.holder).values(v)
      return v.holderId
    })

    const updated = await withTenant(appPool.db, tenantA, (tx) =>
      tx.update(t.holder).set({ name: 'alterado' }).where(eq(t.holder.holderId, holderB)),
    )
    expect(updated).toHaveLength(0)

    const deleted = await withTenant(appPool.db, tenantA, (tx) =>
      tx.delete(t.holder).where(eq(t.holder.holderId, holderB)),
    )
    expect(deleted).toHaveLength(0)
  })

  it('processo KYC: tenant B não acessa processo do tenant A', async () => {
    const holderA = await withTenant(appPool.db, tenantA, async (tx) => {
      const v = newHolder(tenantA)
      await tx.insert(t.holder).values(v)
      return v.holderId
    })
    const kycId = await withTenant(appPool.db, tenantA, async (tx) => {
      const id = randomUUID()
      await tx.insert(t.kycProcess).values({
        kycProcessId: id,
        holderId: holderA,
        tenantId: tenantA,
        state: 'pending',
        legalBasis: 'CONSENT',
      })
      return id
    })

    const fromB = await withTenant(appPool.db, tenantB, (tx) =>
      tx
        .select({ kycProcessId: t.kycProcess.kycProcessId })
        .from(t.kycProcess)
        .where(eq(t.kycProcess.kycProcessId, kycId)),
    )
    expect(fromB).toHaveLength(0)

    const fromA = await withTenant(appPool.db, tenantA, (tx) =>
      tx
        .select({ kycProcessId: t.kycProcess.kycProcessId })
        .from(t.kycProcess)
        .where(eq(t.kycProcess.kycProcessId, kycId)),
    )
    expect(fromA).toHaveLength(1)
  })

  it('evento KYC: insert de tenant diferente do contexto é rejeitado', async () => {
    const holderA = await withTenant(appPool.db, tenantA, async (tx) => {
      const v = newHolder(tenantA)
      await tx.insert(t.holder).values(v)
      return v.holderId
    })
    const kycId = await withTenant(appPool.db, tenantA, async (tx) => {
      const id = randomUUID()
      await tx.insert(t.kycProcess).values({
        kycProcessId: id,
        holderId: holderA,
        tenantId: tenantA,
        state: 'pending',
        legalBasis: 'CONSENT',
      })
      return id
    })

    await expect(
      withTenant(appPool.db, tenantA, (tx) =>
        tx.insert(t.kycEvent).values({
          kycEventId: randomUUID(),
          kycProcessId: kycId,
          tenantId: tenantB,
          eventType: 'created',
          toState: 'pending',
          actor: 'test',
        }),
      ),
    ).rejects.toThrow()
  })

  it('evento KYC: imutabilidade (sem update/delete) preservada', async () => {
    const holderA = await withTenant(appPool.db, tenantA, async (tx) => {
      const v = newHolder(tenantA)
      await tx.insert(t.holder).values(v)
      return v.holderId
    })
    const kycId = await withTenant(appPool.db, tenantA, async (tx) => {
      const id = randomUUID()
      await tx.insert(t.kycProcess).values({
        kycProcessId: id,
        holderId: holderA,
        tenantId: tenantA,
        state: 'pending',
        legalBasis: 'CONSENT',
      })
      return id
    })
    const eventId = await withTenant(appPool.db, tenantA, async (tx) => {
      const id = randomUUID()
      await tx.insert(t.kycEvent).values({
        kycEventId: id,
        kycProcessId: kycId,
        tenantId: tenantA,
        eventType: 'created',
        toState: 'pending',
        actor: 'test',
      })
      return id
    })

    await expect(
      withTenant(appPool.db, tenantA, (tx) =>
        tx.update(t.kycEvent).set({ actor: 'hacker' }).where(eq(t.kycEvent.kycEventId, eventId)),
      ),
    ).rejects.toThrow()

    await expect(
      withTenant(appPool.db, tenantA, (tx) =>
        tx.delete(t.kycEvent).where(eq(t.kycEvent.kycEventId, eventId)),
      ),
    ).rejects.toThrow()
  })

  it('evento KYC: tenant B não acessa eventos do tenant A', async () => {
    const holderA = await withTenant(appPool.db, tenantA, async (tx) => {
      const v = newHolder(tenantA)
      await tx.insert(t.holder).values(v)
      return v.holderId
    })
    const kycId = await withTenant(appPool.db, tenantA, async (tx) => {
      const id = randomUUID()
      await tx.insert(t.kycProcess).values({
        kycProcessId: id,
        holderId: holderA,
        tenantId: tenantA,
        state: 'pending',
        legalBasis: 'CONSENT',
      })
      return id
    })
    await withTenant(appPool.db, tenantA, (tx) =>
      tx.insert(t.kycEvent).values({
        kycEventId: randomUUID(),
        kycProcessId: kycId,
        tenantId: tenantA,
        eventType: 'created',
        toState: 'pending',
        actor: 'test',
      }),
    )

    const fromB = await withTenant(appPool.db, tenantB, (tx) =>
      tx.select({ kycEventId: t.kycEvent.kycEventId }).from(t.kycEvent),
    )
    expect(fromB).toHaveLength(0)
  })
})
