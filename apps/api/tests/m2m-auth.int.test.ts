import { createDbPool, runMigrations } from '@comprova/db'
import { createLogger, createMetrics } from '@comprova/observability'
import { startTestDb, startTestRedis, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

const PEPPER = 'test-pepper-123'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const appPool = createDbPool(db.appUrl)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

const app = await buildApp({
  config: {
    DATABASE_URL: db.appUrl,
    REDIS_URL: testRedis.url,
    API_KEY_PEPPER: PEPPER,
    CREDENTIAL_ISSUER_ORIGIN: 'https://issuer.test',
    CREDENTIAL_SIGNING_KEYS: '[]',
    SIGNING_KEY_PROVIDER: 'local',
    PORT: 3001,
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

let ownerSessionCookie: string
let m2mOrgTenantId: string

const signUp = async (email: string, password: string, name: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { user?: { id: string } }).user!.id
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
  if (!setCookie) throw new Error('No set-cookie header')
  const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie
  const match = cookieHeader.match(/better-auth\.session_token=([^;]+)/)
  const token = match?.[1]
  if (!token) throw new Error('Session token not found in cookie')
  return token
}

const injectWithSession = async (method: string, url: string, body?: unknown) => {
  return app.inject({
    method,
    url,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `better-auth.session_token=${ownerSessionCookie}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

// Requisição pura Bearer (sem cookie de sessão), simulando um backend M2M.
const injectBearer = async (method: string, url: string, secret: string) => {
  return app.inject({
    method,
    url,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
    },
  })
}

beforeAll(async () => {
  await signUp('owner@exemplo.com', 'SenhaForte123!', 'Dono da Organização')
  ownerSessionCookie = await loginAndGetCookie('owner@exemplo.com', 'SenhaForte123!')

  const createRes = await injectWithSession('POST', '/v1/organizations', {
    name: 'Org M2M Auth',
    email: 'owner@exemplo.com',
    termsVersion: '1.0.0',
  })
  expect(createRes.statusCode).toBe(201)
  m2mOrgTenantId = createRes.json().tenantId
})

afterAll(async () => {
  await app.close()
  redis.disconnect()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

describe('Verifier M2M autenticação e revogação', () => {
  it('chave M2M válida autentica via Bearer sem sessão de usuário', async () => {
    const createRes = await injectWithSession('POST', '/v1/m2m/api-keys', {
      tenantId: m2mOrgTenantId,
      name: 'Chave M2M Válida',
      scopes: ['validate:read'],
      keyType: 'm2m',
    })
    expect(createRes.statusCode).toBe(201)
    const secret = createRes.json().secret

    // Nenhum cookie de sessão: somente Bearer token.
    const res = await injectBearer('GET', '/v1/meta', secret)
    expect(res.statusCode).toBe(200)
  })

  it('chave M2M sem scope suficiente é rejeitada com 403', async () => {
    const createRes = await injectWithSession('POST', '/v1/m2m/api-keys', {
      tenantId: m2mOrgTenantId,
      name: 'Chave sem leitura',
      scopes: ['verify:m2m'],
      keyType: 'm2m',
    })
    expect(createRes.statusCode).toBe(201)
    const secret = createRes.json().secret

    // /v1/meta exige validate:read; a chave só tem verify:m2m.
    const res = await injectBearer('GET', '/v1/meta', secret)
    expect(res.statusCode).toBe(403)
  })

  it('não é possível criar chave user com escopo exclusivo de M2M (verify:m2m)', async () => {
    const res = await injectWithSession('POST', '/v1/m2m/api-keys', {
      tenantId: m2mOrgTenantId,
      name: 'Chave user com verify:m2m',
      scopes: ['verify:m2m'],
      keyType: 'user',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_SCOPE')
  })

  it('escopo desconhecido é rejeitado na criação da chave', async () => {
    const res = await injectWithSession('POST', '/v1/m2m/api-keys', {
      tenantId: m2mOrgTenantId,
      name: 'Chave com escopo desconhecido',
      scopes: ['validate:read', 'scope:inexistente'],
      keyType: 'm2m',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_SCOPE')
  })

  it('após revogação, a mesma chave é rejeitada imediatamente', async () => {
    const createRes = await injectWithSession('POST', '/v1/m2m/api-keys', {
      tenantId: m2mOrgTenantId,
      name: 'Chave para revogar',
      scopes: ['validate:read'],
      keyType: 'm2m',
    })
    expect(createRes.statusCode).toBe(201)
    const keyId = createRes.json().apiKey.apiKeyId
    const secret = createRes.json().secret

    // Ainda válida antes da revogação.
    const before = await injectBearer('GET', '/v1/meta', secret)
    expect(before.statusCode).toBe(200)

    const revokeRes = await injectWithSession('DELETE', `/v1/m2m/api-keys/${keyId}`, {
      tenantId: m2mOrgTenantId,
    })
    expect(revokeRes.statusCode).toBe(200)

    // Imediatamente após a revogação (sem esperar o TTL do cache).
    const after = await injectBearer('GET', '/v1/meta', secret)
    expect(after.statusCode).toBe(401)
  })

  it('chave revogada não acessa endpoint protegido mesmo sem sessão', async () => {
    const createRes = await injectWithSession('POST', '/v1/m2m/api-keys', {
      tenantId: m2mOrgTenantId,
      name: 'Chave revogada',
      scopes: ['validate:read'],
      keyType: 'm2m',
    })
    expect(createRes.statusCode).toBe(201)
    const keyId = createRes.json().apiKey.apiKeyId
    const secret = createRes.json().secret

    await injectWithSession('DELETE', `/v1/m2m/api-keys/${keyId}`, { tenantId: m2mOrgTenantId })

    const res = await injectBearer('GET', '/v1/meta', secret)
    expect(res.statusCode).toBe(401)
  })

  it('requisição sem nenhuma credencial não autentica (mas não bloqueia rotas públicas)', async () => {
    // Sem bearer e sem sessão: não há `request.tenant`. Rotas que exigem scope
    // retornam 401; isso não é um 500.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/meta',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.statusCode).toBe(401)
  })
})
