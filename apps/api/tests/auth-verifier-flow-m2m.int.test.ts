import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  TEST_APP_DB_PASSWORD,
  createApiKey,
  createTenant,
  startTestDb,
  startTestRedis,
} from '@comprova/testing'
import { createDbPool, runMigrations, sql } from '@comprova/db'
import Redis from 'ioredis'
import { createLogger, createMetrics } from '@comprova/observability'
import { buildApp } from '../src/app.js'

const PEPPER = 'test-pepper-flow-123'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

await adminPool.db.execute(sql`GRANT USAGE ON SCHEMA public TO app_user`)
await adminPool.db.execute(sql`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO app_user`)

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
  logger: createLogger({ level: 'silent' }),
  metrics: createMetrics(),
})

afterAll(async () => {
  await app.close()
  redis.disconnect()
  await adminPool.end()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

describe('fluxo real de autenticação do Verifier (M2M)', () => {
  let tenantA: string

  beforeAll(async () => {
    tenantA = await createTenant(adminPool.db, { name: 'flow-org-a' })
  })

  it('cenário 9: rotas M2M continuam funcionando (Bearer API key)', async () => {
    const keyMain = (await createApiKey(adminPool.db, tenantA, PEPPER)).plaintext

    const res = await app.inject({
      method: 'GET',
      url: '/v1/validations',
      headers: { Authorization: `Bearer ${keyMain}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().total).toBeGreaterThanOrEqual(0)
  })
})
