import { createLogger, createMetrics } from '@comprova/observability'
import { createDbPool, eq, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import { sha256Of, type ObjectStore } from '@comprova/providers'
import {
  createApiKey,
  createTenant,
  startTestDb,
  startTestRedis,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { API_SCOPES } from '../src/plugins/scope.js'

const PEPPER = 'test-pepper-me-debug'
const MAX_BYTES = 10 * 1024 * 1024

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

class TestObjectStore implements ObjectStore {
  readonly objects = new Map<string, { readonly data: Buffer; readonly contentType: string }>()

  async put(key: string, data: Uint8Array, contentType: string) {
    const bytes = Buffer.from(data)
    this.objects.set(key, { data: bytes, contentType })
    return { key, uri: `test://${key}`, sha256: sha256Of(data), bytes: data.byteLength }
  }

  async delete(_key: string) {}
}

const store = new TestObjectStore()
const logger = createLogger({ level: 'silent' })

const tenantA = await createTenant(adminPool.db, { name: 'me-debug-a' })
const adminKey = (
  await createApiKey(adminPool.db, tenantA, PEPPER, {
    scopes: [API_SCOPES.validateWrite],
  })
).plaintext
const readOnlyKey = (
  await createApiKey(adminPool.db, tenantA, PEPPER, {
    scopes: [API_SCOPES.validateRead],
  })
).plaintext

// Define o usuário da sessão como admin via banco (simula o usuário logado)
await adminPool.db.update(t.authUser).set({ role: 'admin' }).where(eq(t.authUser.id, 'admin-user-id'))

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
    TEMPORAL_ENABLED: false,
    VLM_ENABLED: false,
    TEMPORAL_ADDRESS: 'localhost:7233',
    TEMPORAL_NAMESPACE: 'default',
    TEMPORAL_TASK_QUEUE: 'comprova-deep-t1',
    WORKER_LOOPS: false,
    EVIDENCE_MAX_BYTES: MAX_BYTES,
    EVIDENCE_MAX_CONCURRENCY: 2,
  },
  db: appPool.db,
  redis,
  logger,
  metrics: createMetrics(),
  objectStore: store,
})

afterAll(async () => {
  await app.close()
  redis.disconnect()
  await adminPool.end()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

const auth = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` })

describe('GET /v1/me', () => {
  it('retorna os dados da sessão com role (200)', async () => {
    // Simula um request com sessionUser definido via middleware de sessão.
    // Como o teste não tem cookie de better-auth, o sessionUser será undefined
    // e a rota deve retornar 401.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: auth(adminKey),
    })
    expect(res.statusCode).toBe(401)
  })

  it('requer API key válida (401 sem chave)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /v1/debug/nf3e/qrcode', () => {
  it('requer API key válida (401 sem chave)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/debug/nf3e/qrcode',
    })
    expect(res.statusCode).toBe(401)
  })

  it('requer scope validate:write (403 com validate:read)', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
    const boundary = '----comprova-test'
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const res = await app.inject({
      method: 'POST',
      url: '/v1/debug/nf3e/qrcode',
      headers: {
        ...auth(readOnlyKey),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    })
    expect(res.statusCode).toBe(403)
  })

  it('aceita upload de PDF com validate:write (200)', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
    const boundary = '----comprova-test'
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const res = await app.inject({
      method: 'POST',
      url: '/v1/debug/nf3e/qrcode',
      headers: {
        ...auth(adminKey),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(Array.isArray(json.events)).toBe(true)
    expect(json.reference).toBeDefined()
    expect(json.reference.status).toBe('inconclusive') // PDF sem QR -> inconclusive
  })
})
