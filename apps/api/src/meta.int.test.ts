import {
  createApiKey,
  createTenant,
  seedGoldenDataset,
  startTestDb,
  startTestRedis,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import { createLogger, createMetrics } from '@comprova/observability'
import { createDbPool, runMigrations } from '@comprova/db'
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'

const PEPPER = 'test-pepper-123'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
await seedGoldenDataset(adminPool.db)

const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)
const tenant = await createTenant(adminPool.db, { name: 'meta-tenant' })
const key = (await createApiKey(adminPool.db, tenant, PEPPER)).plaintext

const appPool = createDbPool(db.appUrl)
const app = await buildApp({
  config: {
    DATABASE_URL: db.appUrl,
    REDIS_URL: testRedis.url,
    API_KEY_PEPPER: PEPPER,
    CREDENTIAL_ISSUER_ORIGIN: 'https://issuer.test',
    CREDENTIAL_SIGNING_KEYS: '[]',
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

const fetchMeta = async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/meta',
    headers: { authorization: `Bearer ${key}` },
  })
  expect(res.statusCode).toBe(200)
  return res.json() as {
    datasets: {
      ref_receita_estabelecimento: { snapshot_month: string | null }
      ref_receita_empresa: { snapshot_month: string | null }
      ref_receita_socio: { snapshot_month: string | null }
      ref_cnefe_address: { census_year: number | null }
      ref_cep: { updated_at: string | null; sources: string[] }
      ref_known_shared_address: { created_at: string | null; sources: string[] }
      address_profile: { computed_from_snapshot: string | null }
    }
  }
}

describe('GET /v1/meta', () => {
  it('exige autenticação', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/meta' })
    expect(res.statusCode).toBe(401)
  })

  it('expõe a versão de cada base de referência', async () => {
    const { datasets } = await fetchMeta()

    expect(datasets.ref_receita_estabelecimento.snapshot_month).toBe('2026-09-01')
    expect(datasets.address_profile.computed_from_snapshot).toBe('2026-09-01')
    expect(datasets.ref_cnefe_address.census_year).toBe(2022)
    expect(datasets.ref_cep.sources).toEqual(['golden'])
    expect(datasets.ref_known_shared_address.sources).toEqual(['golden'])
    expect(Number.isNaN(Date.parse(datasets.ref_cep.updated_at ?? ''))).toBe(false)
    expect(Number.isNaN(Date.parse(datasets.ref_known_shared_address.created_at ?? ''))).toBe(false)
  })

  it('não inventa versão para base não carregada', async () => {
    const { datasets } = await fetchMeta()
    // `ref_receita_empresa` não é semeada no dataset dourado; `ref_receita_socio` é.
    expect(datasets.ref_receita_empresa.snapshot_month).toBeNull()
    expect(datasets.ref_receita_socio.snapshot_month).toBe('2026-09-01')
  })

  it('responde o mesmo payload em chamadas repetidas (cache)', async () => {
    const first = await fetchMeta()
    const second = await fetchMeta()
    expect(second).toEqual(first)
  })

  it('deixa a rota visível no OpenAPI', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' })
    expect(res.statusCode).toBe(200)
    const spec = res.json() as { paths: Record<string, unknown> }
    expect(Object.keys(spec.paths)).toContain('/v1/meta')
  })
})
