import {
  createApiKey,
  createSubject,
  createTenant,
  createTestCredentialSigningKey,
  createValidation,
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
const signing = createTestCredentialSigningKey()

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

const tenantA = await createTenant(adminPool.db, { name: 'tenant-a' })
const tenantB = await createTenant(adminPool.db, { name: 'tenant-b', rateLimitRps: 1, burst: 100 })
const keyA = (await createApiKey(adminPool.db, tenantA, PEPPER)).plaintext
const keyB = (await createApiKey(adminPool.db, tenantB, PEPPER)).plaintext
const subjectA = await createSubject(adminPool.db, tenantA)
const validationA = await createValidation(adminPool.db, tenantA, subjectA, {
  verdict: 'RESIDENTIAL',
  explanationSummary: 'Endereco parece residencial.',
})

const appPool = createDbPool(db.appUrl)
const app = await buildApp({
  config: {
    DATABASE_URL: db.appUrl,
    REDIS_URL: testRedis.url,
    API_KEY_PEPPER: PEPPER,
    CREDENTIAL_ISSUER_ORIGIN: 'https://issuer.test',
    CREDENTIAL_SIGNING_KEY_ID: signing.keyId,
    CREDENTIAL_SIGNING_PRIVATE_KEY: signing.privateKeyPkcs8Pem,
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

describe('health endpoints', () => {
  it('healthz responde ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
    expect(res.headers['x-request-id']).toBeDefined()
  })

  it('readyz verifica postgres e redis', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', checks: { postgres: 'ok', redis: 'ok' } })
  })

  it('metrics expoe prometheus', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('http_requests_total')
  })
})

describe('auth', () => {
  it('sem Authorization retorna 401 problem+json', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/validations/${validationA}` })
    expect(res.statusCode).toBe(401)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.json().code).toBe('UNAUTHORIZED')
  })

  it('api key invalida retorna 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/validations/${validationA}`,
      headers: { authorization: 'Bearer cvkdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rota inexistente retorna 404 problem+json', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/problem+json')
  })
})

describe('GET /v1/validations/:id', () => {
  it('retorna validacao do proprio tenant com headers de rate limit', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/validations/${validationA}`,
      headers: { authorization: `Bearer ${keyA}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.validation_id).toBe(validationA)
    expect(body.verdict).toBe('RESIDENTIAL')
    expect(body.explanation).toBe('Endereco parece residencial.')
    expect(Array.isArray(body.signals)).toBe(true)
    expect(res.headers['ratelimit-limit']).toBeDefined()
    expect(res.headers['ratelimit-remaining']).toBeDefined()
    expect(res.headers['ratelimit-reset']).toBeDefined()
  })

  it('validacao de outro tenant retorna 404 (isolamento)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/validations/${validationA}`,
      headers: { authorization: `Bearer ${keyB}` },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('NOT_FOUND')
  })

  it('ETag gera 304 com If-None-Match', async () => {
    const first = await app.inject({
      method: 'GET',
      url: `/v1/validations/${validationA}`,
      headers: { authorization: `Bearer ${keyA}` },
    })
    const etag = first.headers['etag']
    expect(etag).toBeDefined()
    const second = await app.inject({
      method: 'GET',
      url: `/v1/validations/${validationA}`,
      headers: { authorization: `Bearer ${keyA}`, 'if-none-match': etag as string },
    })
    expect(second.statusCode).toBe(304)
  })
})

describe('rate limit', () => {
  it('atingido burst devolve 429 com Retry-After', async () => {
    const tenantC = await createTenant(adminPool.db, { name: 'tenant-c', rateLimitRps: 1, burst: 2 })
    const keyC = (await createApiKey(adminPool.db, tenantC, PEPPER)).plaintext
    const subjectC = await createSubject(adminPool.db, tenantC)
    const validationC = await createValidation(adminPool.db, tenantC, subjectC)

    const injectC = () =>
      app.inject({
        method: 'GET',
        url: `/v1/validations/${validationC}`,
        headers: { authorization: `Bearer ${keyC}` },
      })
    const results: readonly number[] = [
      (await injectC()).statusCode,
      (await injectC()).statusCode,
      (await injectC()).statusCode,
      (await injectC()).statusCode,
    ]
    expect(results.slice(0, 2)).toEqual([200, 200])
    expect(results[2]).toBe(429)
    expect(results[3]).toBe(429)
  })

  it('429 inclui headers de rate limit e problema problem+json', async () => {
    const tenantD = await createTenant(adminPool.db, { name: 'tenant-d', rateLimitRps: 1, burst: 1 })
    const keyD = (await createApiKey(adminPool.db, tenantD, PEPPER)).plaintext
    const subjectD = await createSubject(adminPool.db, tenantD)
    const validationD = await createValidation(adminPool.db, tenantD, subjectD)

    const inject = () =>
      app.inject({
        method: 'GET',
        url: `/v1/validations/${validationD}`,
        headers: { authorization: `Bearer ${keyD}` },
      })
    const first = await inject()
    expect(first.statusCode).toBe(200)
    const second = await inject()
    expect(second.statusCode).toBe(429)
    expect(second.headers['retry-after']).toBeDefined()
    expect(second.json().code).toBe('RATE_LIMITED')
  })
})
