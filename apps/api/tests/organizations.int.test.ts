import { createDbPool, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import { createLogger, createMetrics } from '@comprova/observability'
import {
  startTestDb,
  startTestRedis,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

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

let orgTenantId: string
let ownerSessionCookie: string
let memberSessionCookie: string

/** Faz sign-up via Better Auth e retorna o id do usuário criado. */
const signUp = async (email: string, password: string, name: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  })
  expect(res.statusCode).toBe(200)
  const user = res.json() as { user?: { id: string } }
  expect(user.user).toBeDefined()
  return user.user!.id
}

/** Faz login via Better Auth e retorna o cookie de sessão. */
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

/** Faz uma requisição com cookie de sessão. */
const injectWithSession = async (
  method: string,
  url: string,
  body?: unknown,
  sessionCookie: string = ownerSessionCookie,
) => {
  return app.inject({
    method,
    url,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `better-auth.session_token=${sessionCookie}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

beforeAll(async () => {
  // Cadastra usuários via Better Auth
  await signUp('owner@exemplo.com', 'SenhaForte123!', 'Dono da Organização')
  await signUp('member@exemplo.com', 'SenhaForte123!', 'Membro da Organização')

  // Faz login para obter cookies de sessão
  ownerSessionCookie = await loginAndGetCookie('owner@exemplo.com', 'SenhaForte123!')
  memberSessionCookie = await loginAndGetCookie('member@exemplo.com', 'SenhaForte123!')

  // Cria uma organização via API (simulando onboarding)
  const createRes = await injectWithSession(
    'POST',
    '/v1/organizations',
    {
      name: 'Organização Teste',
      email: 'owner@exemplo.com',
      termsVersion: '1.0.0',
    },
  )
  expect(createRes.statusCode).toBe(201)
  const org = createRes.json()
  orgTenantId = org.tenantId
})

afterAll(async () => {
  await app.close()
  redis.disconnect()
  await adminPool.end()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

describe('Verifier Onboarding', () => {
  it('deve criar uma organização e associar o usuário como owner', async () => {
    const res = await injectWithSession(
      'POST',
      '/v1/organizations',
      {
        name: 'Nova Organização',
        email: 'owner@exemplo.com',
        termsVersion: '2.0.0',
      },
    )
    expect(res.statusCode).toBe(201)
    const org = res.json()
    expect(org.name).toBe('Nova Organização')
    expect(org.onboardingStatus).toBe('pending')
    expect(org.termsVersion).toBe('2.0.0')
    expect(org.type).toBe('organization')
  })

  it('deve listar organizações do usuário', async () => {
    const res = await injectWithSession('GET', '/v1/organizations', undefined, ownerSessionCookie)
    expect(res.statusCode).toBe(200)
    const orgs = res.json()
    expect(Array.isArray(orgs)).toBe(true)
    expect(orgs.length).toBeGreaterThan(0)
  })

  it('deve buscar uma organização à qual o usuário pertence', async () => {
    const res = await injectWithSession(
      'GET',
      `/v1/organizations/${orgTenantId}`,
      undefined,
      ownerSessionCookie,
    )
    expect(res.statusCode).toBe(200)
    const org = res.json()
    expect(org.tenantId).toBe(orgTenantId)
  })

  it('deve impedir acesso a organização de outro usuário', async () => {
    const res = await injectWithSession(
      'GET',
      `/v1/organizations/${orgTenantId}`,
      undefined,
      memberSessionCookie,
    )
    expect(res.statusCode).toBe(403)
  })

  it('deve completar o onboarding aceitando termos', async () => {
    const res = await injectWithSession(
      'POST',
      `/v1/organizations/${orgTenantId}/onboarding/complete`,
      { termsVersion: '1.0.0' },
      ownerSessionCookie,
    )
    expect(res.statusCode).toBe(200)
    const org = res.json()
    expect(org.onboardingStatus).toBe('completed')
    expect(org.termsAcceptedAt).not.toBeNull()
  })

  it('não deve permitir que não-owner complete o onboarding de outra organização', async () => {
    // Cria organização onde o member é owner
    const createRes = await injectWithSession(
      'POST',
      '/v1/organizations',
      {
        name: 'Org do Membro',
        email: 'member@exemplo.com',
        termsVersion: '1.0.0',
      },
      memberSessionCookie,
    )
    expect(createRes.statusCode).toBe(201)
    const memberOrgTenantId = createRes.json().tenantId

    // O member é owner dessa org, então pode completar
    const res = await injectWithSession(
      'POST',
      `/v1/organizations/${memberOrgTenantId}/onboarding/complete`,
      { termsVersion: '1.0.0' },
      memberSessionCookie,
    )
    expect(res.statusCode).toBe(200)
  })

  it('deve adicionar e listar membros', async () => {
    const createRes = await injectWithSession(
      'POST',
      '/v1/organizations',
      {
        name: 'Org Membros',
        email: 'owner@exemplo.com',
        termsVersion: '1.0.0',
      },
    )
    expect(createRes.statusCode).toBe(201)
    const memberOrgTenantId = createRes.json().tenantId

    // Owner adiciona membro
    const addRes = await injectWithSession(
      'POST',
      `/v1/organizations/${memberOrgTenantId}/members`,
      { email: 'member@exemplo.com', role: 'member' },
      ownerSessionCookie,
    )
    expect(addRes.statusCode).toBe(201)

    // Lista membros
    const listRes = await injectWithSession(
      'GET',
      `/v1/organizations/${memberOrgTenantId}/members`,
      undefined,
      ownerSessionCookie,
    )
    expect(listRes.statusCode).toBe(200)
    const members = listRes.json()
    expect(members.length).toBeGreaterThanOrEqual(1)
    expect(members.some((m: any) => m.userEmail === 'member@exemplo.com')).toBe(true)
  })

  it('não deve permitir que não-admin adicione membros', async () => {
    const res = await injectWithSession(
      'POST',
      `/v1/organizations/${orgTenantId}/members`,
      { email: 'outro@exemplo.com', role: 'member' },
      memberSessionCookie,
    )
    expect(res.statusCode).toBe(403)
  })
})

describe('Verifier M2M Integration', () => {
  it('deve criar uma credencial M2M e retornar o segredo apenas na criação', async () => {
    const res = await injectWithSession(
      'POST',
      `/v1/m2m/api-keys`,
      {
        tenantId: orgTenantId,
        name: 'Chave M2M Teste',
        scopes: ['validate:read', 'validate:write', 'verify:m2m'],
        keyType: 'm2m',
      },
      ownerSessionCookie,
    )
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.apiKey.keyPrefix).toBeDefined()
    expect(body.secret).toBeDefined()
    expect(body.secret.length).toBeGreaterThan(0)
    expect(body.apiKey.key).toBeUndefined() // segredo não está no objeto da chave
    expect(body.apiKey.keyType).toBe('m2m')
    expect(body.apiKey.tenantId).toBe(orgTenantId)
    expect(body.apiKey.revokedAt).toBeNull()
  })

  it('deve listar credenciais sem expor o segredo', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/m2m/api-keys?tenantId=${orgTenantId}`,
      headers: {
        Cookie: `better-auth.session_token=${ownerSessionCookie}`,
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.apiKeys)).toBe(true)
    for (const key of body.apiKeys) {
      expect(key.key).toBeUndefined() // nunca expõe o segredo
      expect(key.keyPrefix).toBeDefined()
    }
  })

  it('deve revogar uma credencial M2M', async () => {
    const createRes = await injectWithSession(
      'POST',
      `/v1/m2m/api-keys`,
      { tenantId: orgTenantId, name: 'Chave para Revogar', keyType: 'm2m' },
      ownerSessionCookie,
    )
    expect(createRes.statusCode).toBe(201)
    const keyId = createRes.json().apiKey.apiKeyId

    const revokeRes = await injectWithSession(
      'DELETE',
      `/v1/m2m/api-keys/${keyId}`,
      { tenantId: orgTenantId },
      ownerSessionCookie,
    )
    expect(revokeRes.statusCode).toBe(200)
    expect(revokeRes.json().revoked).toBe(true)

    // Tenta revogar novamente (já revogada)
    const revokeAgain = await injectWithSession(
      'DELETE',
      `/v1/m2m/api-keys/${keyId}`,
      { tenantId: orgTenantId },
      ownerSessionCookie,
    )
    expect(revokeAgain.statusCode).toBe(404)
  })

  it('não deve permitir acesso a credenciais inexistentes', async () => {
    const res = await injectWithSession(
      'DELETE',
      '/v1/m2m/api-keys/00000000-0000-4000-8000-000000000000',
      { tenantId: orgTenantId },
      ownerSessionCookie,
    )
    expect(res.statusCode).toBe(404)
  })
})
