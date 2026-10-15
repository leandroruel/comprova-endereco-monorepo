import {
  createApiKey,
  createTenant,
  seedGoldenDataset,
  startTestDb,
  startTestRedis,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import { createLogger, createMetrics } from '@comprova/observability'
import { createDbPool, runMigrations, eq } from '@comprova/db'
import * as t from '@comprova/db'
import { buildFastPathDeps } from './app.js'
import { buildApp } from './app.js'
import { batchTick } from './services/batch-processor.js'
import { publishTick } from './services/outbox-publisher.js'
import { verifyWebhookSignature } from './webhooks.js'
import Redis from 'ioredis'
import { appendFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'

const PEPPER = 'test-pepper-123'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
await seedGoldenDataset(adminPool.db)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)
const tenant = await createTenant(adminPool.db, { name: 'f2-tenant' })
const key = (await createApiKey(adminPool.db, tenant, PEPPER)).plaintext

const appPool = createDbPool(db.appUrl)
const app = await buildApp({
  config: {
    DATABASE_URL: db.appUrl,
    REDIS_URL: testRedis.url,
    API_KEY_PEPPER: PEPPER,
    PORT: 3000,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    POLICY_VERSION: '2026.11.1',
    TEMPORAL_ENABLED: false,
    VLM_ENABLED: false,
    TEMPORAL_ADDRESS: 'localhost:7233',
    TEMPORAL_NAMESPACE: 'default',
    TEMPORAL_TASK_QUEUE: 'comprova-deep-t1',
    WORKER_LOOPS: false,
  },
  db: appPool.db,
  redis,
  logger: createLogger({
    level: 'info',
    stream: { write: (l) => appendFileSync('/tmp/opencode/f2.log', l) },
  }),
  metrics: createMetrics(),
})

const auth = { authorization: `Bearer ${key}` }
const authJson = { ...auth, 'content-type': 'application/json' }

afterAll(async () => {
  await app.close()
  redis.disconnect()
  await adminPool.end()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

describe('webhooks', () => {
  it('CRUD cria, lista e remove endpoint', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: authJson,
      payload: { url: 'https://example.com/hook', events: ['validation.completed'] },
    })
    expect(created.statusCode).toBe(200)
    const { endpoint_id: endpointId, secret } = created.json()
    expect(secret).toMatch(/^whsec_/)

    const list = await app.inject({ method: 'GET', url: '/v1/webhooks', headers: auth })
    expect(list.statusCode).toBe(200)
    expect(list.json().endpoints.length).toBe(1)

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/webhooks/${endpointId}`,
      headers: auth,
    })
    expect(removed.statusCode).toBe(200)
    expect(removed.json().deleted).toBe(true)
  })

  it('URL privada e rejeitada', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: authJson,
      payload: { url: 'http://localhost:9999/hook', events: ['validation.completed'] },
    })
    expect(res.statusCode).toBe(422)
  })

  it('dispatcher entrega evento com assinatura valida e registra delivery', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: authJson,
      payload: { url: 'https://example.com/hook', events: ['validation.completed'] },
    })
    const { endpoint_id: endpointId, secret } = created.json()

    const validationRes = await app.inject({
      method: 'POST',
      url: '/v1/validations',
      headers: authJson,
      payload: {
        document: { type: 'CNPJ', value: '12345678000195' },
        address: null,
        mode: 'fast',
        legal_basis: 'FRAUD_PREVENTION',
      },
    })
    expect(validationRes.statusCode).toBe(200)

    const delivered: { body: string; headers: Record<string, string> }[] = []
    const fakeFetch = (async (url: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
      delivered.push({
        body: init?.body ?? '',
        headers: Object.fromEntries(Object.entries(init?.headers ?? {})) as Record<string, string>,
      })
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    await publishTick({
      db: adminPool.db,
      pepper: PEPPER,
      logger: createLogger({ level: 'silent' }),
      fetchImpl: fakeFetch,
    })

    expect(delivered.length).toBe(1)
    const call = delivered[0] as { body: string; headers: Record<string, string> }
    expect(call.headers['X-Signature']).toBeDefined()
    expect(
      verifyWebhookSignature(
        secret,
        call.body,
        Number(call.headers['X-Timestamp']),
        call.headers['X-Signature'] as string,
      ),
    ).toBe(true)

    const deliveries = await adminPool.db
      .select()
      .from(t.webhookDelivery)
      .where(eq(t.webhookDelivery.endpointId, endpointId))
    expect(deliveries.length).toBe(1)
    expect(deliveries[0]?.status).toBe('delivered')
  })

  it('delivery falha com backoff e para apos maximo de tentativas', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: authJson,
      payload: { url: 'https://unreachable.example/hook', events: ['validation.completed'] },
    })
    const { endpoint_id: endpointId } = created.json()

    const validationRes = await app.inject({
      method: 'POST',
      url: '/v1/validations',
      headers: { ...authJson, 'idempotency-key': 'f2-backoff-key-1' },
      payload: {
        document: { type: 'CNPJ', value: '23456789000195' },
        address: null,
        mode: 'fast',
        legal_basis: 'FRAUD_PREVENTION',
      },
    })
    expect(validationRes.statusCode).toBe(200)

    const failingFetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const deps = {
      db: adminPool.db,
      pepper: PEPPER,
      logger: createLogger({ level: 'silent' }),
      fetchImpl: failingFetch,
      now: () => new Date(),
      maxAttempts: 2,
    }
    await publishTick(deps)
    await publishTick({ ...deps, now: () => new Date(Date.now() + 3_600_000) })
    const afterTwo = await adminPool.db
      .select()
      .from(t.webhookDelivery)
      .where(eq(t.webhookDelivery.endpointId, endpointId))
    expect(afterTwo[0]?.status).toBe('failed')
    expect(afterTwo[0]?.attempt).toBe(2)
  })
})

describe('batch', () => {
  it('cria lote 202, processa via tick e finaliza', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/batches',
      headers: authJson,
      payload: {
        items: [
          { type: 'CNPJ', value: '12345678000195' },
          { type: 'CNPJ', value: '11111111111111' },
        ],
        mode: 'fast',
        legal_basis: 'FRAUD_PREVENTION',
      },
    })
    expect(created.statusCode).toBe(202)
    const { batch_id: batchId } = created.json()

    const fastPath = buildFastPathDeps(appPool.db, {
      DATABASE_URL: db.appUrl,
      REDIS_URL: testRedis.url,
      API_KEY_PEPPER: PEPPER,
      PORT: 3000,
      HOST: '127.0.0.1',
      LOG_LEVEL: 'silent',
      POLICY_VERSION: '2026.11.1',
      TEMPORAL_ENABLED: false,
      VLM_ENABLED: false,
      TEMPORAL_ADDRESS: 'localhost:7233',
      TEMPORAL_NAMESPACE: 'default',
      TEMPORAL_TASK_QUEUE: 'comprova-deep-t1',
      WORKER_LOOPS: false,
    })

    const processed1 = await batchTick({ adminDb: adminPool.db, fastPath })
    const processed2 = await batchTick({ adminDb: adminPool.db, fastPath })
    expect(processed1 + processed2).toBe(2)

    const summary = await app.inject({ method: 'GET', url: `/v1/batches/${batchId}`, headers: auth })
    expect(summary.statusCode).toBe(200)
    const body = summary.json()
    expect(body.status).toBe('completed')
    const ok = body.items.find(
      (i: { doc_type: string; status: string }) => i.doc_type === 'CNPJ' && i.status === 'completed',
    )
    const failed = body.items.find((i: { status: string }) => i.status === 'failed')
    expect(ok?.validation_id).toBeDefined()
    expect(failed?.error_code).toContain('INVALID_DOCUMENT')
  })

  it('lote de outro tenant e invisivel (RLS)', async () => {
    const otherTenant = await createTenant(adminPool.db, { name: 'f2-other' })
    const otherKey = (await createApiKey(adminPool.db, otherTenant, PEPPER)).plaintext
    const created = await app.inject({
      method: 'POST',
      url: '/v1/batches',
      headers: authJson,
      payload: {
        items: [{ type: 'CNPJ', value: '12345678000195' }],
        mode: 'fast',
        legal_basis: 'FRAUD_PREVENTION',
      },
    })
    const { batch_id: batchId } = created.json()
    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/batches/${batchId}`,
      headers: { authorization: `Bearer ${otherKey}` },
    })
    expect(foreign.statusCode).toBe(404)
  })
})
