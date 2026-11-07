import { and, createDbPool, eq, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { validationBillingKey, QuotaExceededError } from '@comprova/db'
import { z } from 'zod'
import { UsageConsumptionDtoSchema, UsageEventDtoSchema, UsageQuotaDtoSchema } from '@comprova/contracts'
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
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- beforeEach é usado em vários describes abaixo
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- beforeEach é usado em vários describes abaixo
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
  await adminPool.db.delete(t.usageBillingUnit).where(eq(t.usageBillingUnit.tenantId, tenantId))
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
    const rejected = results.filter((r) => r.status === 'rejected')
    // Apenas uma das duas concorrentes deve conseguir (resta 1 unidade); a outra
    // é rejeitada por cota hard.
    expect(succeeded).toBe(1)
    expect(rejected).toHaveLength(1)

    // A rejeição deve ser um QuotaExceededError (erro de negócio, não transitório).
    const rejection = rejected[0]!
    expect(rejection.status).toBe('rejected')
    expect(rejection.reason).toBeInstanceOf(QuotaExceededError)

    // Após a rejeição, não deve haver linha extra de usage_event além da
    // inicial (conc-1) e da que venceu a concorrência (conc-2 ou conc-3).
    const rows = await withTenant(appPool.db, tenantId, (tx) =>
      tx
        .select({ eventId: t.usageEvent.eventId, idempotencyKey: t.usageEvent.idempotencyKey })
        .from(t.usageEvent)
        .where(eq(t.usageEvent.tenantId, tenantId))
        .orderBy(t.usageEvent.occurredAt),
    )
    expect(rows).toHaveLength(2)
    const keys = new Set(rows.map((r) => r.idempotencyKey))
    expect(keys.has('conc-1')).toBe(true)
    expect([...keys].filter((k) => k !== 'conc-1')).toHaveLength(1)
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

  it('validação partial/queued sem evento → sem divergência', async () => {
    const partialSubject = randomUUID()
    const queuedSubject = randomUUID()
    const partialId = randomUUID()
    const queuedId = randomUUID()
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx.insert(t.subject).values([
        { subjectId: partialSubject, tenantId, docType: 'CNPJ', docHmac: Buffer.from('partial') },
        { subjectId: queuedSubject, tenantId, docType: 'CNPJ', docHmac: Buffer.from('queued') },
      ])
      await tx.insert(t.validation).values([
        {
          validationId: partialId,
          tenantId,
          subjectId: partialSubject,
          mode: 'fast',
          status: 'partial',
          verdict: 'INSUFFICIENT_EVIDENCE',
          score: 0.5,
          confidence: 0.9,
          policyVersion: '2026.11.1',
          legalBasis: 'CONSENT',
          createdAt: now,
          completedAt: now,
          expiresAt: new Date(now.getTime() + 30 * 86_400_000),
        },
        {
          validationId: queuedId,
          tenantId,
          subjectId: queuedSubject,
          mode: 'auto',
          status: 'queued',
          verdict: 'INSUFFICIENT_EVIDENCE',
          score: 0.5,
          confidence: 0.9,
          policyVersion: '2026.11.1',
          legalBasis: 'CONSENT',
          createdAt: now,
          completedAt: null,
          expiresAt: new Date(now.getTime() + 30 * 86_400_000),
        },
      ])
    })
    const body = await reconcile()

    expect(body.completedValidations).toBe(0)
    expect(body.divergences).toEqual([])
  })

  it('validação concluída fora do período (antes de periodStart e em periodEnd) → excluída', async () => {
    const periodEndDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))

    // concluída antes do período (dia 10 do mês anterior)
    const beforeId = randomUUID()
    const beforeSubject = randomUUID()
    // concluída exatamente em periodEnd (o bound superior é exclusivo → excluída)
    const atEndId = randomUUID()
    const atEndSubject = randomUUID()
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx.insert(t.subject).values([
        { subjectId: beforeSubject, tenantId, docType: 'CNPJ', docHmac: Buffer.from('before') },
        { subjectId: atEndSubject, tenantId, docType: 'CNPJ', docHmac: Buffer.from('atend') },
      ])
      await tx.insert(t.validation).values([
        {
          validationId: beforeId,
          tenantId,
          subjectId: beforeSubject,
          mode: 'fast',
          status: 'completed',
          verdict: 'INSUFFICIENT_EVIDENCE',
          score: 0.5,
          confidence: 0.9,
          policyVersion: '2026.11.1',
          legalBasis: 'CONSENT',
          createdAt: now,
          completedAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 10)),
          expiresAt: new Date(now.getTime() + 30 * 86_400_000),
        },
        {
          validationId: atEndId,
          tenantId,
          subjectId: atEndSubject,
          mode: 'fast',
          status: 'completed',
          verdict: 'INSUFFICIENT_EVIDENCE',
          score: 0.5,
          confidence: 0.9,
          policyVersion: '2026.11.1',
          legalBasis: 'CONSENT',
          createdAt: now,
          completedAt: new Date(periodEndDate),
          expiresAt: new Date(now.getTime() + 30 * 86_400_000),
        },
      ])
    })

    const body = await reconcile()
    // Ambas concluídas fora do período não entram na base de comparação.
    expect(body.completedValidations).toBe(0)
    expect(body.divergences).toEqual([])
  })

  it('evento de uso com occurred_at fora do período → excluído de usageEvents e divergências', async () => {
    const validationId = await insertValidation('completed', now)
    // evento dentro do período
    await insertEvent('evt-in', validationId, true, 1)
    // evento fora do período (mês anterior)
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx.insert(t.usageEvent).values({
        eventId: randomUUID(),
        tenantId,
        eventType: 'usage_event',
        kind: 'fast',
        units: 1,
        validationId,
        idempotencyKey: 'evt-out',
        billable: true,
        source: 'fast',
        occurredAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 10)),
      })
    })

    const body = await reconcile()
    expect(body.completedValidations).toBe(1)
    // usageEvents conta apenas os no período; o evento fora do período não gera divergência.
    expect(body.usageEvents).toBe(1)
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

  it('paginação com limit menor que o total e offset que pula a primeira página', async () => {
    // 7 eventos faturáveis, todos no período (occurredAt = now)
    for (let i = 1; i <= 7; i++) {
      await insertEvent(`pagmulti-${i}`, randomUUID(), true, 1, 'fast')
    }

    // Página 1: limit=3, offset=0 → 3 eventos, total continua 7
    const res1 = await injectM2M('GET', '/v1/usage/events?limit=3&offset=0', apiKeySecret)
    expect(res1.statusCode).toBe(200)
    const body1 = res1.json()
    expect(body1.total).toBe(7)
    expect(body1.limit).toBe(3)
    expect(body1.offset).toBe(0)
    expect(body1.events).toHaveLength(3)
    const ids1 = new Set(body1.events.map((e: { eventId: string }) => e.eventId))

    // Página 2: limit=3, offset=3 → 3 eventos, total continua 7, sem repetir da página 1
    const res2 = await injectM2M('GET', '/v1/usage/events?limit=3&offset=3', apiKeySecret)
    expect(res2.statusCode).toBe(200)
    const body2 = res2.json()
    expect(body2.total).toBe(7)
    expect(body2.limit).toBe(3)
    expect(body2.offset).toBe(3)
    expect(body2.events).toHaveLength(3)
    const ids2 = new Set(body2.events.map((e: { eventId: string }) => e.eventId))
    expect([...ids2].some((id) => ids1.has(id))).toBe(false)

    // Página 3: limit=3, offset=6 → 1 evento (o último), total continua 7
    const res3 = await injectM2M('GET', '/v1/usage/events?limit=3&offset=6', apiKeySecret)
    expect(res3.statusCode).toBe(200)
    const body3 = res3.json()
    expect(body3.total).toBe(7)
    expect(body3.events).toHaveLength(1)

    // As três páginas juntas cobrem todos os 7 eventos sem sobreposição.
    const allIds = new Set([...ids1, ...ids2, ...body3.events.map((e: { eventId: string }) => e.eventId)])
    expect(allIds.size).toBe(7)
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

describe('usage metering — consumo com fixtures abrangendo o período', () => {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))

  beforeEach(async () => {
    await setQuota(1000)
    await clearUsage()
  })

  const insertEventAt = async (
    idempotencyKey: string,
    validationId: string | null,
    billable: boolean,
    units: number,
    eventType: 'usage_event' | 'processing_attempt' | 'technical_execution',
    occurredAt: Date,
  ) => {
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx.insert(t.usageEvent).values({
        eventId: randomUUID(),
        tenantId,
        eventType,
        kind: 'fast',
        units,
        validationId: validationId ?? null,
        idempotencyKey,
        billable,
        source: 'fast',
        occurredAt,
      })
    })
  }

  it('soma apenas eventos dentro do período, por event_type e billable', async () => {
    const inside = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15))
    const atStart = new Date(monthStart) // boundary inclusivo
    const before = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 20)) // antes do período
    const atEnd = new Date(monthEnd) // boundary exclusivo (periodEnd é exclusivo)
    const after = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 5)) // depois do período

    // dentro do período, faturáveis
    const v1 = randomUUID()
    const v2 = randomUUID()
    const v3 = randomUUID()
    await insertEventAt('c-in-1', v1, true, 2, 'usage_event', inside)
    await insertEventAt('c-in-2', v2, true, 3, 'usage_event', atStart)
    // dentro do período, não faturável
    await insertEventAt('c-in-3', null, false, 1, 'processing_attempt', inside)
    // dentro do período, outro tipo faturável
    await insertEventAt('c-in-4', v3, true, 1, 'technical_execution', inside)
    // fora do período (antes) — deve ser excluído
    await insertEventAt('c-before', randomUUID(), true, 99, 'usage_event', before)
    // fora do período (em periodEnd, exclusivo) — deve ser excluído
    await insertEventAt('c-at-end', randomUUID(), true, 99, 'usage_event', atEnd)
    // fora do período (depois) — deve ser excluído
    await insertEventAt('c-after', randomUUID(), true, 99, 'usage_event', after)

    const res = await injectM2M('GET', '/v1/usage/consumption', apiKeySecret)
    expect(res.statusCode).toBe(200)
    const body = res.json()

    // 4 eventos dentro do período (inside, atStart x2 tipos, processing_attempt)
    expect(body.totalEvents).toBe(4)
    // unidades faturáveis: 2 + 3 + 1 (o processing_attempt não é billable)
    expect(body.totalBillableUnits).toBe(6)
    // custo: nenhum tem costMicros → null
    expect(body.totalCostMicros).toBeNull()
    // distribuição por tipo dentro do período
    expect(body.byEventType).toEqual({
      usage_event: 2, // inside + atStart (usage_event)
      processing_attempt: 1,
      technical_execution: 1,
    })
  })
})

describe('usage metering — contrato compartilhado (@comprova/contracts)', () => {
  beforeEach(async () => {
    await setQuota(1000)
    await clearUsage()
  })

  it('a resposta HTTP de events valida contra UsageEventDtoSchema (com e sem validationId)', async () => {
    const withValidation = randomUUID()
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx.insert(t.usageEvent).values([
        {
          eventId: randomUUID(),
          tenantId,
          eventType: 'usage_event',
          kind: 'fast',
          units: 1,
          validationId: withValidation,
          idempotencyKey: 'contract-1',
          billable: true,
          source: 'fast',
          occurredAt: now,
        },
        {
          eventId: randomUUID(),
          tenantId,
          eventType: 'technical_execution',
          kind: 'fast',
          units: 1,
          validationId: null,
          idempotencyKey: null,
          billable: false,
          source: 'fast',
          occurredAt: now,
        },
      ])
    })

    const res = await injectM2M('GET', '/v1/usage/events?limit=50&offset=0', apiKeySecret)
    expect(res.statusCode).toBe(200)
    const body = res.json() as { events: unknown[] }
    expect(body.events).toHaveLength(2)

    const parsed = z.array(UsageEventDtoSchema).safeParse(body.events)
    expect(parsed.success).toBe(true)

    const events = body.events as { eventId: string | null; tenantId: string; validationId: string | null }[]
    // eventId corresponde ao registro persistido e tenantId ao tenant autenticado.
    const persisted = await withTenant(appPool.db, tenantId, (tx) =>
      tx
        .select({ eventId: t.usageEvent.eventId, validationId: t.usageEvent.validationId })
        .from(t.usageEvent)
        .where(eq(t.usageEvent.tenantId, tenantId)),
    )
    const persistedIds = new Set(persisted.map((row) => row.eventId))
    for (const event of events) {
      expect(event.tenantId).toBe(tenantId)
      if (event.eventId !== null) expect(persistedIds.has(event.eventId)).toBe(true)
    }
    expect(events.filter((e) => e.validationId === withValidation)).toHaveLength(1)
    expect(events.filter((e) => e.validationId === null)).toHaveLength(1)
  })

  it('respostas de consumption e quota validam contra os DTOs compartilhados', async () => {
    const consumption = await injectM2M('GET', '/v1/usage/consumption', apiKeySecret)
    expect(consumption.statusCode).toBe(200)
    expect(UsageConsumptionDtoSchema.safeParse(consumption.json()).success).toBe(true)

    const quota = await injectM2M('GET', '/v1/usage/quota', apiKeySecret)
    expect(quota.statusCode).toBe(200)
    expect(UsageQuotaDtoSchema.safeParse(quota.json()).success).toBe(true)
  })
})

describe('usage metering — identidade comercial (uma unidade faturável por validação)', () => {
  const getService = async () => {
    const { makeUsageService } = await import('../src/modules/usage/usage.service.js')
    return makeUsageService({ db: appPool.db })
  }

  const record = async (input: {
    readonly tenantId: string
    readonly validationId: string
    readonly kind: 'fast' | 'deep'
    readonly idempotencyKey: string | null
  }) => {
    const service = await getService()
    return withTenant(appPool.db, input.tenantId, (tx) =>
      service.recordUsageEventInTx(tx, {
        tenantId: input.tenantId,
        eventType: 'usage_event',
        kind: input.kind,
        units: 1,
        validationId: input.validationId,
        idempotencyKey: input.idempotencyKey,
        billable: true,
        source: input.kind,
      }),
    )
  }

  const billableCount = async (tenant: string, validationId: string): Promise<number> => {
    const rows = await withTenant(appPool.db, tenant, (tx) =>
      tx
        .select({ eventId: t.usageEvent.eventId })
        .from(t.usageEvent)
        .where(
          and(
            eq(t.usageEvent.tenantId, tenant),
            eq(t.usageEvent.validationId, validationId),
            eq(t.usageEvent.billable, true),
          ),
        ),
    )
    return rows.length
  }

  beforeEach(async () => {
    await setQuota(1000)
    await clearUsage()
  })

  it('fast fatura e deep processa a mesma validação: apenas uma unidade faturável', async () => {
    const validationId = randomUUID()

    // Fast com chave arbitrária (comportamento legado): a identidade comercial
    // é a validation, não a chave.
    const fast = await record({ tenantId, validationId, kind: 'fast', idempotencyKey: 'fast-sim-1' })
    expect(fast.replayed).toBe(false)

    // Deep com a chave canônica.
    const deep = await record({
      tenantId,
      validationId,
      kind: 'deep',
      idempotencyKey: validationBillingKey(validationId),
    })
    expect(deep.replayed).toBe(true)
    expect(deep.eventId).toBe(fast.eventId)

    expect(await billableCount(tenantId, validationId)).toBe(1)
  })

  it('deep fatura primeiro e fast tenta registrar a mesma validação: apenas uma unidade faturável', async () => {
    const validationId = randomUUID()

    const deep = await record({
      tenantId,
      validationId,
      kind: 'deep',
      idempotencyKey: validationBillingKey(validationId),
    })
    expect(deep.replayed).toBe(false)

    const fast = await record({ tenantId, validationId, kind: 'fast', idempotencyKey: 'fast-sim-2' })
    expect(fast.replayed).toBe(true)
    expect(fast.eventId).toBe(deep.eventId)

    expect(await billableCount(tenantId, validationId)).toBe(1)
  })

  it('fast e deep CONCORRENTES para a mesma validação: apenas uma unidade faturável', async () => {
    const validationId = randomUUID()

    const results = await Promise.allSettled([
      record({ tenantId, validationId, kind: 'fast', idempotencyKey: 'race-fast' }),
      record({ tenantId, validationId, kind: 'deep', idempotencyKey: 'race-deep' }),
    ])

    const fresh = results.filter((r) => r.status === 'fulfilled' && r.value.replayed === false)
    expect(fresh).toHaveLength(1)

    const billedRows = await withTenant(appPool.db, tenantId, (tx) =>
      tx
        .select({ eventId: t.usageEvent.eventId })
        .from(t.usageEvent)
        .where(and(eq(t.usageEvent.tenantId, tenantId), eq(t.usageEvent.billable, true))),
    )
    expect(billedRows).toHaveLength(1)

    const unitRows = await adminPool.db
      .select({ validationId: t.usageBillingUnit.validationId })
      .from(t.usageBillingUnit)
      .where(eq(t.usageBillingUnit.tenantId, tenantId))
    expect(unitRows).toHaveLength(1)
    expect(unitRows[0]!.validationId).toBe(validationId)
  })

  it('duas validações diferentes do mesmo tenant: duas unidades faturáveis legítimas', async () => {
    const v1 = randomUUID()
    const v2 = randomUUID()

    const first = await record({
      tenantId,
      validationId: v1,
      kind: 'fast',
      idempotencyKey: validationBillingKey(v1),
    })
    const second = await record({
      tenantId,
      validationId: v2,
      kind: 'fast',
      idempotencyKey: validationBillingKey(v2),
    })

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(false)
    expect(second.eventId).not.toBe(first.eventId)
    expect(await billableCount(tenantId, v1)).toBe(1)
    expect(await billableCount(tenantId, v2)).toBe(1)
  })

  it('mesmo validationId em tenants diferentes: isolamento correto', async () => {
    const otherTenantId = await createTenant(adminPool.db, { name: 'usage-metering-other-tenant' })
    const validationId = randomUUID()

    const first = await record({
      tenantId,
      validationId,
      kind: 'fast',
      idempotencyKey: validationBillingKey(validationId),
    })
    const second = await record({
      tenantId: otherTenantId,
      validationId,
      kind: 'fast',
      idempotencyKey: validationBillingKey(validationId),
    })

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(false)
    expect(second.eventId).not.toBe(first.eventId)
    expect(await billableCount(tenantId, validationId)).toBe(1)
    expect(await billableCount(otherTenantId, validationId)).toBe(1)

    // Limpeza do tenant auxiliar (evita FK/RLS residues nos próximos testes).
    await adminPool.db.delete(t.usageEvent).where(eq(t.usageEvent.tenantId, otherTenantId))
    await adminPool.db
      .delete(t.usageEventIdempotency)
      .where(eq(t.usageEventIdempotency.tenantId, otherTenantId))
    await adminPool.db.delete(t.usageBillingUnit).where(eq(t.usageBillingUnit.tenantId, otherTenantId))
    await adminPool.db.delete(t.tenant).where(eq(t.tenant.tenantId, otherTenantId))
  })

  it('quota excedida: evento faturável para validação diferente lança QuotaExceededError', async () => {
    const validationId1 = randomUUID()
    const validationId2 = randomUUID()
    const key1 = validationBillingKey(validationId1)
    const key2 = validationBillingKey(validationId2)

    await setQuota(1)

    // Primeiro evento faturável consome a quota
    const first = await record({ tenantId, validationId: validationId1, kind: 'fast', idempotencyKey: key1 })
    expect(first.replayed).toBe(false)

    // Segundo evento faturável para validação diferente deve lançar QuotaExceededError
    const service = await getService()
    await expect(
      withTenant(appPool.db, tenantId, async (tx) => {
        await service.recordUsageEventInTx(tx, {
          tenantId,
          eventType: 'usage_event',
          kind: 'fast',
          units: 1,
          validationId: validationId2,
          idempotencyKey: key2,
          billable: true,
          source: 'fast',
        })
      }),
    ).rejects.toThrow(QuotaExceededError)

    // Nenhum evento faturável extra foi criado para validationId2
    const count = await billableCount(tenantId, validationId2)
    expect(count).toBe(0)

    // O evento original continua existindo (não foi removido pelo rollback)
    const count1 = await billableCount(tenantId, validationId1)
    expect(count1).toBe(1)
  })

  it('retry após falha transacional: sem duplicação de unidade faturável', async () => {
    const validationId = randomUUID()
    const key = validationBillingKey(validationId)

    // A primeira tentativa falha no meio da transação: nada persiste
    // (idempotência, identidade comercial e evento inclusive). A chamada é
    // feita DENTRO da mesma transação do negócio, como no fast/deep.
    const service = await getService()
    await expect(
      withTenant(appPool.db, tenantId, async (tx) => {
        await service.recordUsageEventInTx(tx, {
          tenantId,
          eventType: 'usage_event',
          kind: 'fast',
          units: 1,
          validationId,
          idempotencyKey: key,
          billable: true,
          source: 'fast',
        })
        throw new Error('falha transacional simulada')
      }),
    ).rejects.toThrow('falha transacional simulada')

    const unitRows = await adminPool.db
      .select({ validationId: t.usageBillingUnit.validationId })
      .from(t.usageBillingUnit)
      .where(eq(t.usageBillingUnit.tenantId, tenantId))
    expect(unitRows).toHaveLength(0)

    // Retry: registra normalmente (não é replay da tentativa falha).
    const retry = await record({ tenantId, validationId, kind: 'fast', idempotencyKey: key })
    expect(retry.replayed).toBe(false)

    // E um replay subsequente não duplica.
    const replay = await record({ tenantId, validationId, kind: 'deep', idempotencyKey: key })
    expect(replay.replayed).toBe(true)
    expect(replay.eventId).toBe(retry.eventId)

    expect(await billableCount(tenantId, validationId)).toBe(1)
  })

  it('replay após cota esgotada retorna o evento existente (unidade comercial protegida)', async () => {
    const validationId = randomUUID()
    const key = validationBillingKey(validationId)

    await setQuota(1)
    const first = await record({ tenantId, validationId, kind: 'fast', idempotencyKey: key })
    expect(first.replayed).toBe(false)

    // Cota já consumida: a MESMA validação continua retornando o evento
    // registrado em vez de ser rejeitada ou de duplicar consumo.
    const replay = await record({ tenantId, validationId, kind: 'deep', idempotencyKey: 'deep-mesmo-replay' })
    expect(replay.replayed).toBe(true)
    expect(replay.eventId).toBe(first.eventId)
    expect(await billableCount(tenantId, validationId)).toBe(1)
  })
})

describe('usage metering — autenticação por sessão e M2M', () => {
  const signUp = async (email: string, password: string, name: string): Promise<void> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
    })
    expect(res.statusCode).toBe(200)
  }

  const loginAndGetCookie = async (email: string, password: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    expect(res.statusCode).toBe(200)
    const setCookie = res.headers['set-cookie']
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie ?? '')
    const token = cookieHeader.match(/better-auth\.session_token=([^;]+)/)?.[1]
    if (!token) throw new Error('Session token not found in cookie')
    return token
  }

  const injectWithSession = async (method: string, url: string, cookie: string) =>
    app.inject({ method, url, headers: { Cookie: `better-auth.session_token=${cookie}` } })

  const createOrganization = async (cookie: string, name: string, email: string): Promise<string> => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { Cookie: `better-auth.session_token=${cookie}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, termsVersion: '1.0.0' }),
    })
    expect(created.statusCode).toBe(201)
    return (created.json() as { tenantId: string }).tenantId
  }

  let userACookie = ''
  let userBCookie = ''
  let orgATenantId = ''
  let orgBTenantId = ''

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8)
    await signUp(`usage-a-${suffix}@exemplo.com`, 'SenhaForte123!', 'Usuário A')
    await signUp(`usage-b-${suffix}@exemplo.com`, 'SenhaForte123!', 'Usuário B')
    userACookie = await loginAndGetCookie(`usage-a-${suffix}@exemplo.com`, 'SenhaForte123!')
    userBCookie = await loginAndGetCookie(`usage-b-${suffix}@exemplo.com`, 'SenhaForte123!')
    orgATenantId = await createOrganization(userACookie, 'Org A Usage', `usage-a-${suffix}@exemplo.com`)
    orgBTenantId = await createOrganization(userBCookie, 'Org B Usage', `usage-b-${suffix}@exemplo.com`)
  })

  it('sessão válida com tenant associado acessa as quatro rotas', async () => {
    for (const url of [
      `/v1/usage/consumption?tenantId=${orgATenantId}`,
      `/v1/usage/quota?tenantId=${orgATenantId}`,
      `/v1/usage/events?tenantId=${orgATenantId}`,
      `/v1/usage/reconcile?tenantId=${orgATenantId}`,
    ]) {
      const res = await injectWithSession('GET', url, userACookie)
      expect(res.statusCode, url).toBe(200)
    }
  })

  it('sessão tentando acessar tenant de outra organização: 403', async () => {
    for (const url of [
      `/v1/usage/consumption?tenantId=${orgBTenantId}`,
      `/v1/usage/quota?tenantId=${orgBTenantId}`,
      `/v1/usage/events?tenantId=${orgBTenantId}`,
      `/v1/usage/reconcile?tenantId=${orgBTenantId}`,
    ]) {
      const res = await injectWithSession('GET', url, userACookie)
      expect(res.statusCode, url).toBe(403)
    }
  })

  it('sessão sem tenantId na query: 400 (sem selecionar organização arbitrária)', async () => {
    for (const url of [
      '/v1/usage/consumption',
      '/v1/usage/quota',
      '/v1/usage/events',
      '/v1/usage/reconcile',
    ]) {
      const res = await injectWithSession('GET', url, userACookie)
      expect(res.statusCode, url).toBe(400)
      expect((res.json() as { code?: string }).code).toBe('MISSING_TENANT_ID')
    }
  })

  it('M2M válido sem tenantId no query resolve o tenant pela API key', async () => {
    for (const url of [
      '/v1/usage/consumption',
      '/v1/usage/quota',
      '/v1/usage/events',
      '/v1/usage/reconcile',
    ]) {
      const res = await injectM2M('GET', url, apiKeySecret)
      expect(res.statusCode, url).toBe(200)
    }
  })

  it('M2M tentando manipular tenant por query string: 403', async () => {
    const res = await injectM2M('GET', `/v1/usage/events?tenantId=${orgATenantId}`, apiKeySecret)
    expect(res.statusCode).toBe(403)
  })

  it('API key sem validate:read: 403 nos endpoints de uso', async () => {
    const { plaintext } = await createApiKey(appPool.db, tenantId, PEPPER, {
      keyType: 'm2m',
      scopes: ['verify:m2m'],
    })
    const res = await injectM2M('GET', '/v1/usage/consumption', plaintext)
    expect(res.statusCode).toBe(403)
  })
})
