import { createDbPool, eq, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { runMigrations } from '@comprova/db'
import { createLogger, createMetrics } from '@comprova/observability'
import {
  startTestDb,
  startTestRedis,
  TEST_APP_DB_PASSWORD,
  createApiKey,
  createTenant,
} from '@comprova/testing'
import Redis from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { randomUUID } from 'node:crypto'
import type { UsageReconciliationResponse } from '../src/modules/usage/usage.schema.js'

const PEPPER = 'test-pepper-123'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

const appPool = createDbPool(db.appUrl)
const app = await buildApp({
  config: {
    DATABASE_URL: db.appUrl,
    REDIS_URL: testRedis.url,
    API_KEY_PEPPER: PEPPER,
    CREDENTIAL_ISSUER_ORIGIN: 'https://issuer.test',
    CREDENTIAL_SIGNING_KEYS: '[]',
    SIGNING_KEY_PROVIDER: 'local',
    PORT: 3000,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    POLICY_VERSION: '2026.11.1',
    TERMS_VERSION: '1.0.0',
    TERMS_APPROVED: 'true',
    TERMS_DOCUMENT_HASH: 'sha256:abc123def456',
    TEMPORAL_ENABLED: false,
    VLM_ENABLED: false,
    TEMPORAL_ADDRESS: 'localhost:7233',
    TEMPORAL_NAMESPACE: 'default',
    TEMPORAL_TASK_QUEUE: 'comprova-deep-t1',
    WORKER_LOOPS: false,
  },
  db: appPool.db,
  redis,
  logger: createLogger({ level: 'silent' }),
  metrics: createMetrics(),
})

const injectM2M = async (method: string, url: string, secret: string) => {
  return app.inject({
    method,
    url,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
    },
  })
}

let tenantId: string
let apiKeySecret: string
const now = new Date()

beforeAll(async () => {
  tenantId = await createTenant(adminPool.db, { name: 'usage-metering-tenant' })
  const { plaintext } = await createApiKey(appPool.db, tenantId, PEPPER, {
    keyType: 'm2m',
    scopes: ['validate:read', 'validate:write'],
  })
  apiKeySecret = plaintext
})

afterAll(async () => {
  await adminPool.end()
  await appPool.end()
  await redis.quit()
  await db.stop()
})

const setQuota = async (quota: number | null) => {
  await adminPool.db
    .update(t.tenant)
    .set({ monthlyQuota: quota === null ? null : quota })
    .where(eq(t.tenant.tenantId, tenantId))
}

const clearUsage = async () => {
  await adminPool.db.delete(t.usageEvent).where(eq(t.usageEvent.tenantId, tenantId))
  await adminPool.db.delete(t.usageEventIdempotency).where(eq(t.usageEventIdempotency.tenantId, tenantId))
}

const clearValidations = async () => {
  await adminPool.db.delete(t.validation).where(eq(t.validation.tenantId, tenantId))
  await adminPool.db.delete(t.subject).where(eq(t.subject.tenantId, tenantId))
}

const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()

describe('usage metering — idempotência', () => {
  beforeEach(async () => {
    await setQuota(100)
    await clearUsage()
  })

  it('replay após cota atingida não é rejeitado por cota (replayed: true)', async () => {
    const { makeUsageService } = await import('../src/modules/usage/usage.service.js')
    const service = makeUsageService({ db: appPool.db })

    const key = 'replay-quota-key'
    await setQuota(1)
    const first = await withTenant(appPool.db, tenantId, (tx) =>
      service.recordUsageEventInTx(tx, {
        tenantId,
        eventType: 'usage_event',
        kind: 'fast',
        units: 1,
        idempotencyKey: key,
        billable: true,
        source: 'fast',
      }),
    )
    expect(first.replayed).toBe(false)

    const replay = await withTenant(appPool.db, tenantId, (tx) =>
      service.recordUsageEventInTx(tx, {
        tenantId,
        eventType: 'usage_event',
        kind: 'fast',
        units: 1,
        idempotencyKey: key,
        billable: true,
        source: 'fast',
      }),
    )
    expect(replay.replayed).toBe(true)
    expect(replay.eventId).toBe(first.eventId)

    const rows = await withTenant(appPool.db, tenantId, (tx) =>
      tx.select({ id: t.usageEvent.eventId }).from(t.usageEvent).where(eq(t.usageEvent.idempotencyKey, key)),
    )
    expect(rows).toHaveLength(1)
  })

  it('retry após falha (mesma chave) não duplica evento', async () => {
    const { makeUsageService } = await import('../src/modules/usage/usage.service.js')
    const service = makeUsageService({ db: appPool.db })

    const key = 'retry-key'
    await setQuota(100)
    const first = await withTenant(appPool.db, tenantId, (tx) =>
      service.recordUsageEventInTx(tx, {
        tenantId,
        eventType: 'usage_event',
        kind: 'fast',
        units: 1,
        idempotencyKey: key,
        billable: true,
        source: 'fast',
      }),
    )
    expect(first.replayed).toBe(false)

    const retry = await withTenant(appPool.db, tenantId, (tx) =>
      service.recordUsageEventInTx(tx, {
        tenantId,
        eventType: 'usage_event',
        kind: 'fast',
        units: 5,
        idempotencyKey: key,
        billable: true,
        source: 'fast',
      }),
    )
    expect(retry.replayed).toBe(true)
    expect(retry.eventId).toBe(first.eventId)

    const rows = await withTenant(appPool.db, tenantId, (tx) =>
      tx.select({ id: t.usageEvent.eventId }).from(t.usageEvent).where(eq(t.usageEvent.idempotencyKey, key)),
    )
    expect(rows).toHaveLength(1)
  })

  it('duas requisições concorrentes próximas do limite não ultrapassam', async () => {
    await setQuota(2)
    const { makeUsageService } = await import('../src/modules/usage/usage.service.js')
    const service = makeUsageService({ db: appPool.db })

    await withTenant(appPool.db, tenantId, (tx) =>
      service.recordUsageEventInTx(tx, {
        tenantId,
        eventType: 'usage_event',
        kind: 'fast',
        units: 1,
        idempotencyKey: 'conc-1',
        billable: true,
        source: 'fast',
      }),
    )

    const results = await Promise.allSettled([
      withTenant(appPool.db, tenantId, (tx) =>
        service.recordUsageEventInTx(tx, {
          tenantId,
          eventType: 'usage_event',
          kind: 'fast',
          units: 1,
          idempotencyKey: 'conc-2',
          billable: true,
          source: 'fast',
        }),
      ),
      withTenant(appPool.db, tenantId, (tx) =>
        service.recordUsageEventInTx(tx, {
          tenantId,
          eventType: 'usage_event',
          kind: 'fast',
          units: 1,
          idempotencyKey: 'conc-3',
          billable: true,
          source: 'fast',
        }),
      ),
    ])

    const succeeded = results.filter(
      (r) => r.status === 'fulfilled' && r.value.replayed === false && r.value.eventId !== null,
    ).length
    const rejected = results.filter((r) => r.status === 'rejected').length
    // Apenas uma das duas concorrentes deve conseguir (resta 1 unidade); a outra
    // é rejeitada por cota hard.
    expect(succeeded).toBe(1)
    expect(rejected).toBe(1)
  })

  it('deep não consome quando cota já atingida', async () => {
    await setQuota(1)
    const { makeUsageService } = await import('../src/modules/usage/usage.service.js')
    const service = makeUsageService({ db: appPool.db })

    await withTenant(appPool.db, tenantId, (tx) =>
      service.recordUsageEventInTx(tx, {
        tenantId,
        eventType: 'usage_event',
        kind: 'fast',
        units: 1,
        idempotencyKey: 'deep-quota-1',
        billable: true,
        source: 'fast',
      }),
    )

    await expect(
      withTenant(appPool.db, tenantId, (tx) =>
        service.recordUsageEventInTx(tx, {
          tenantId,
          eventType: 'usage_event',
          kind: 'deep',
          units: 1,
          validationId: randomUUID(),
          idempotencyKey: 'deep-quota-2',
          billable: true,
          source: 'deep',
        }),
      ),
    ).rejects.toThrow()
  })
})

describe('usage metering — cotas', () => {
  beforeEach(async () => {
    await clearUsage()
  })

  it('cota ausente (monthly_quota = NULL) não bloqueia', async () => {
    await setQuota(null)
    const { makeUsageService } = await import('../src/modules/usage/usage.service.js')
    const service = makeUsageService({ db: appPool.db })

    const result = await withTenant(appPool.db, tenantId, (tx) =>
      service.recordUsageEventInTx(tx, {
        tenantId,
        eventType: 'usage_event',
        kind: 'fast',
        units: 1000,
        idempotencyKey: 'no-quota-key',
        billable: true,
        source: 'fast',
      }),
    )
    expect(result.replayed).toBe(false)
  })

  it('cota soft alerta sem bloqueio (softThresholdPercent constante 80)', async () => {
    await setQuota(100)
    const res = await injectM2M('GET', '/v1/usage/quota', apiKeySecret)
    const body = res.json()

    expect(body.softThresholdPercent).toBe(80)
  })

  it('cota hard bloqueia quando limite atingido', async () => {
    await setQuota(2)
    const { makeUsageService } = await import('../src/modules/usage/usage.service.js')
    const service = makeUsageService({ db: appPool.db })

    await withTenant(appPool.db, tenantId, (tx) =>
      service.recordUsageEventInTx(tx, {
        tenantId,
        eventType: 'usage_event',
        kind: 'fast',
        units: 1,
        idempotencyKey: 'hard-1',
        billable: true,
        source: 'fast',
      }),
    )
    await withTenant(appPool.db, tenantId, (tx) =>
      service.recordUsageEventInTx(tx, {
        tenantId,
        eventType: 'usage_event',
        kind: 'fast',
        units: 1,
        idempotencyKey: 'hard-2',
        billable: true,
        source: 'fast',
      }),
    )

    await expect(
      withTenant(appPool.db, tenantId, (tx) =>
        service.recordUsageEventInTx(tx, {
          tenantId,
          eventType: 'usage_event',
          kind: 'fast',
          units: 1,
          idempotencyKey: 'hard-3',
          billable: true,
          source: 'fast',
        }),
      ),
    ).rejects.toThrow()
  })
})

describe('usage metering — reconciliação', () => {
  beforeEach(async () => {
    await setQuota(1000)
    await clearUsage()
    await clearValidations()
  })

  const insertValidation = async (
    status: 'completed' | 'partial' | 'queued' = 'completed',
    completedAt: Date | null = now,
  ): Promise<string> => {
    const validationId = randomUUID()
    const subjectId = randomUUID()
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx.insert(t.subject).values({
        subjectId,
        tenantId,
        docType: 'CNPJ',
        docHmac: Buffer.from('x'),
      })
      await tx.insert(t.validation).values({
        validationId,
        tenantId,
        subjectId,
        mode: 'fast',
        status,
        verdict: 'INSUFFICIENT_EVIDENCE',
        score: 0.5,
        confidence: 0.9,
        policyVersion: '2026.11.1',
        legalBasis: 'CONSENT',
        createdAt: now,
        completedAt,
        expiresAt: new Date(now.getTime() + 30 * 86_400_000),
      })
    })
    return validationId
  }

  const insertEvent = async (
    idempotencyKey: string,
    validationId: string | null,
    billable: boolean,
    units: number,
    kind: 'fast' | 'deep' = 'fast',
  ) => {
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx.insert(t.usageEvent).values({
        eventId: randomUUID(),
        tenantId,
        eventType: 'usage_event',
        kind,
        units,
        validationId: validationId ?? null,
        idempotencyKey,
        billable,
        source: kind,
        occurredAt: now,
      })
    })
  }

  const reconcile = async (): Promise<UsageReconciliationResponse> => {
    const res = await injectM2M(
      'GET',
      `/v1/usage/reconcile?periodStart=${encodeURIComponent(periodStart)}&periodEnd=${encodeURIComponent(
        periodEnd,
      )}`,
      apiKeySecret,
    )
    expect(res.statusCode).toBe(200)
    return res.json() as UsageReconciliationResponse
  }

  it('validação concluída sem evento → validation_without_event', async () => {
    await insertValidation('completed', now)
    const body = await reconcile()
    expect(body.completedValidations).toBe(1)
    expect(body.divergences.find((d) => d.type === 'validation_without_event')).toBeDefined()
  })

  it('evento não faturável associado a validação concluída → billability_mismatch', async () => {
    const validationId = await insertValidation('completed', now)
    await insertEvent('evt-nonbill', validationId, false, 1)
    const body = await reconcile()

    const div = body.divergences.find((d) => d.type === 'billability_mismatch')
    expect(div).toBeDefined()
    expect(div!.validationId).toBe(validationId)
  })

  it('eventos faturáveis duplicados para mesma validação → duplicate_event', async () => {
    const validationId = await insertValidation('completed', now)
    await insertEvent('evt-dup-1', validationId, true, 1)
    await insertEvent('evt-dup-2', validationId, true, 1)
    const body = await reconcile()

    const div = body.divergences.find((d) => d.type === 'duplicate_event')
    expect(div).toBeDefined()
    expect(div!.validationId).toBe(validationId)
  })

  it('divergência de unidades → unit_mismatch', async () => {
    const validationId = await insertValidation('completed', now)
    await insertEvent('evt-unit', validationId, true, 5)
    const body = await reconcile()

    const div = body.divergences.find((d) => d.type === 'unit_mismatch')
    expect(div).toBeDefined()
    expect(div!.validationId).toBe(validationId)
  })

  it('evento sem validação correspondente → event_without_validation', async () => {
    await insertEvent('evt-no-val', randomUUID(), true, 1)
    const body = await reconcile()

    expect(body.divergences.find((d) => d.type === 'event_without_validation')).toBeDefined()
  })

  it('evento com validationId nulo → event_without_validation', async () => {
    await insertEvent('evt-null-id', null, true, 1)
    const body = await reconcile()

    expect(body.divergences.find((d) => d.type === 'event_without_validation')).toBeDefined()
  })

  it('validação concluída com exatamente 1 evento faturável de 1 unidade → sem divergência', async () => {
    const validationId = await insertValidation('completed', now)
    await insertEvent('evt-ok', validationId, true, 1)
    const body = await reconcile()

    expect(body.divergences).toEqual([])
  })
})

describe('usage metering — paginação e parsing', () => {
  beforeEach(async () => {
    await setQuota(1000)
    await clearUsage()
  })

  const insertEvent = async (
    idempotencyKey: string,
    validationId: string | null,
    billable: boolean,
    units: number,
    kind: 'fast' | 'deep' = 'fast',
  ) => {
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx.insert(t.usageEvent).values({
        eventId: randomUUID(),
        tenantId,
        eventType: 'usage_event',
        kind,
        units,
        validationId: validationId ?? null,
        idempotencyKey,
        billable,
        source: kind,
        occurredAt: now,
      })
    })
  }

  it('total corresponde ao conjunto filtrado (billable + eventType)', async () => {
    await insertEvent('pag-1', randomUUID(), true, 1, 'fast')
    await insertEvent('pag-2', randomUUID(), true, 1, 'fast')
    await insertEvent('pag-3', randomUUID(), true, 1, 'fast')
    await insertEvent('pag-4', randomUUID(), false, 1, 'fast')
    await insertEvent('pag-5', randomUUID(), false, 1, 'fast')
    await insertEvent('pag-6', randomUUID(), true, 1, 'deep')

    const res = await injectM2M(
      'GET',
      '/v1/usage/events?billable=true&eventType=usage_event&limit=50&offset=0',
      apiKeySecret,
    )
    const body = res.json()

    // billable=true + eventType=usage_event → 4 eventos (3 fast + 1 deep)
    expect(body.total).toBe(4)
    expect(body.events).toHaveLength(4)
  })

  it('parsing billable=true/false, limit, offset válidos', async () => {
    await insertEvent('parse-1', randomUUID(), true, 1, 'fast')

    const resTrue = await injectM2M('GET', '/v1/usage/events?billable=true&limit=10&offset=0', apiKeySecret)
    expect(resTrue.statusCode).toBe(200)

    const resFalse = await injectM2M('GET', '/v1/usage/events?billable=false&limit=10&offset=0', apiKeySecret)
    expect(resFalse.statusCode).toBe(200)

    const resLimit = await injectM2M('GET', '/v1/usage/events?limit=20&offset=10', apiKeySecret)
    expect(resLimit.statusCode).toBe(200)
  })

  it('parsing billable invalido retorna 400', async () => {
    const res = await injectM2M('GET', '/v1/usage/events?billable=sim', apiKeySecret)
    expect(res.statusCode).toBe(400)
  })

  it('periodStart/periodEnd como datetime', async () => {
    const res = await injectM2M(
      'GET',
      '/v1/usage/consumption?periodStart=2026-11-01T00:00:00.000Z&periodEnd=2026-12-01T00:00:00.000Z',
      apiKeySecret,
    )
    expect(res.statusCode).toBe(200)
  })
})
