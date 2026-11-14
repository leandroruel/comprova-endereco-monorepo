import {
  createApiKey,
  createTenant,
  seedGoldenDataset,
  startTestDb,
  startTestRedis,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import { createLogger, createMetrics } from '@comprova/observability'
import type { SafeFetch } from '@comprova/providers'
import { and, createDbPool, runMigrations, eq } from '@comprova/db'
import * as t from '@comprova/db'
import { buildApp, buildFastPathDeps } from '../src/app.js'
import { batchTick } from '../src/services/batch-processor.js'
import { publishTick } from '../src/modules/webhooks/outbox-publisher.js'
import { verifyWebhookSignature } from '../src/modules/webhooks/webhook-crypto.js'
import Redis from 'ioredis'
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
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
        legal_basis: 'FRAUD_PREVENTION',
      },
    })
    expect(validationRes.statusCode).toBe(200)

    const delivered: { body: string; headers: Record<string, string> }[] = []
    const fakeSafeFetch: SafeFetch = async (_url, init) => {
      delivered.push({
        body: typeof init?.body === 'string' ? init.body : '',
        headers: Object.fromEntries(Object.entries(init?.headers ?? {})) as Record<string, string>,
      })
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('ok'),
        address: '8.8.8.8',
      }
    }

    await publishTick({
      db: adminPool.db,
      pepper: PEPPER,
      logger: createLogger({ level: 'silent' }),
      safeFetch: fakeSafeFetch,
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
        legal_basis: 'FRAUD_PREVENTION',
      },
    })
    expect(validationRes.statusCode).toBe(200)

    const failingSafeFetch: SafeFetch = async () => {
      throw new Error('network down')
    }
    const deps = {
      db: adminPool.db,
      pepper: PEPPER,
      logger: createLogger({ level: 'silent' }),
      safeFetch: failingSafeFetch,
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
        documents: [
          { type: 'CNPJ', value: '12345678000195' },
          { type: 'CNPJ', value: '11111111111111' },
        ],
        legal_basis: 'FRAUD_PREVENTION',
      },
    })
    expect(created.statusCode).toBe(202)
    const { batch_id: batchId } = created.json()

    const fastPath = buildFastPathDeps(appPool.db, {
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
        documents: [{ type: 'CNPJ', value: '12345678000195' }],
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

  it('registra o usuario autenticado como ator da auditoria no processamento em lote', async () => {
    const actorUserId = randomUUID()

    // Cria o usuario (FK de batch.userId referencia auth_user).
    await adminPool.db.insert(t.authUser).values({
      id: actorUserId,
      name: 'Batch Actor',
      email: 'batch-actor@exemplo.com',
      emailVerified: true,
    })

    // Cria um lote diretamente no banco com userId preenchido (simula o
    // usuario autenticado por sessao que originou o lote).
    const batchId = randomUUID()
    await adminPool.db.insert(t.batch).values({
      batchId,
      tenantId: tenant,
      userId: actorUserId,
      status: 'queued',
      totalItems: 1,
      mode: 'fast',
      legalBasis: 'FRAUD_PREVENTION',
    })
    const itemId = randomUUID()
    await adminPool.db.insert(t.batchItem).values({
      itemId,
      batchId,
      tenantId: tenant,
      position: 0,
      docType: 'CNPJ',
      docDigits: '12345678000195',
      status: 'pending',
    })

    const fastPath = buildFastPathDeps(appPool.db, {
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
      WORKER_LOOPS: false,
    })

    // Executa o tick: o batch-processor deve propagar userId para o
    // FastPathTenantContext, resultando em session:<userId> no auditLog.
    await batchTick({ adminDb: adminPool.db, fastPath })

    // O tick processa todos os itens pendentes, inclusive de outros lotes
    // criados no mesmo arquivo. Escopa a auditoria pela validacao gerada para
    // o item deste lote para nao depender do estado global da tabela.
    const [processedItem] = await adminPool.db
      .select({ status: t.batchItem.status, validationId: t.batchItem.validationId })
      .from(t.batchItem)
      .where(eq(t.batchItem.itemId, itemId))
    expect(processedItem?.status).toBe('completed')
    expect(processedItem?.validationId).not.toBeNull()

    const auditRows = await adminPool.db
      .select({ actor: t.auditLog.actor })
      .from(t.auditLog)
      .where(
        and(
          eq(t.auditLog.action, 'validation.create'),
          eq(t.auditLog.targetId, processedItem!.validationId!),
        ),
      )
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.actor).toBe(`session:${actorUserId}`)
  })
})
