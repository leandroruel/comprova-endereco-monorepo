import {
  createApiKey,
  createTenant,
  startTestDb,
  startTestRedis,
  TEST_APP_DB_PASSWORD,
  seedGoldenDataset,
  GOLDEN_CASES,
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
const tenant = await createTenant(adminPool.db, { name: 'golden-tenant' })
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

const postValidation = (cnpj: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/validations',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
    payload: {
      document: { type: 'CNPJ', value: cnpj },
      address: null,
      mode: 'fast',
      legal_basis: 'FRAUD_PREVENTION',
    },
  })

describe('dataset dourado T0 (gate >= 85% por classe)', () => {
  it('todas as classes T0 batem o veredito esperado', async () => {
    const results = await GOLDEN_CASES.reduce<
      Promise<readonly { label: string; expected: string; actual: string; confidence: number }[]>
    >(async (acc, testCase) => {
      const prior = await acc
      const res = await postValidation(testCase.cnpj)
      if (res.statusCode !== 200) {
        return [
          ...prior,
          {
            label: testCase.label,
            expected: testCase.expectedVerdict,
            actual: `HTTP ${res.statusCode}: ${res.body.slice(0, 120)}`,
            confidence: 0,
          },
        ]
      }
      const body = res.json()
      return [
        ...prior,
        {
          label: testCase.label,
          expected: testCase.expectedVerdict,
          actual: body.verdict,
          confidence: body.confidence,
        },
      ]
    }, Promise.resolve([]))

    const perClass = new Map<string, { correct: number; total: number }>()
    for (const r of results) {
      const entry = perClass.get(r.expected) ?? { correct: 0, total: 0 }
      perClass.set(r.expected, {
        correct: entry.correct + (r.actual === r.expected ? 1 : 0),
        total: entry.total + 1,
      })
    }
    const failures = results.filter((r) => r.actual !== r.expected)
    const accuracyByClass = [...perClass.entries()].map(([cls, v]) => `${cls}: ${v.correct}/${v.total}`)
    expect(failures, `falhas: ${JSON.stringify(failures, null, 2)} | ${accuracyByClass.join(', ')}`).toEqual(
      [],
    )
    for (const [, v] of perClass) {
      expect(v.correct / v.total).toBeGreaterThanOrEqual(0.85)
    }
  })

  it('resposta inclui sinais, politica versionada e building key', async () => {
    const res = await postValidation(GOLDEN_CASES[0]?.cnpj as string)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.policy_version).toBe('2026.11.1')
    expect(body.signals.length).toBeGreaterThan(3)
    expect(body.address).not.toBeNull()
    expect(body.address.building_key).toMatch(/^b64:/)
    expect(body.expires_at).toBeDefined()
  })

  it('Idempotency-Key devolve a mesma validacao', async () => {
    const cnpj = GOLDEN_CASES[0]?.cnpj as string
    const first = await postValidation(cnpj, { 'idempotency-key': 'golden-idem-key-1' })
    const second = await postValidation(cnpj, { 'idempotency-key': 'golden-idem-key-1' })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(second.json().validation_id).toBe(first.json().validation_id)
  })

  it('CNPJ com digitos invalidos retorna 422 INVALID_DOCUMENT', async () => {
    const res = await postValidation('11111111111111')
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('INVALID_DOCUMENT')
  })

  it('CPF sem endereco retorna 422 ADDRESS_REQUIRED_FOR_CPF', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/validations',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: {
        document: { type: 'CPF', value: '52998224725' },
        address: null,
        mode: 'fast',
        legal_basis: 'CONSENT',
      },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('ADDRESS_REQUIRED_FOR_CPF')
  })

  it('mode deep responde 422 quando VLM desabilitado', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/validations',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: {
        document: { type: 'CNPJ', value: GOLDEN_CASES[0]?.cnpj },
        address: null,
        mode: 'deep',
        legal_basis: 'FRAUD_PREVENTION',
      },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('DEEP_PATH_DISABLED')
  })
})
