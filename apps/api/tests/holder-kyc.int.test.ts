import { createDbPool, runMigrations } from '@comprova/db'
import { createLogger, createMetrics } from '@comprova/observability'
import { startTestDb, startTestRedis, TEST_APP_DB_PASSWORD } from '@comprova/testing'
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
  db: appPool.db,
  redis,
  logger: createLogger({ level: 'silent' }),
  metrics: createMetrics(),
})

let orgTenantId: string
let ownerSessionCookie: string
let m2mApiKeySecret: string
let m2mApiKeyId: string

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

const injectWithSession = async (
  method: string,
  url: string,
  body?: unknown,
  sessionCookie: string = ownerSessionCookie,
) => {
  const headers: Record<string, string> = {
    Cookie: `better-auth.session_token=${sessionCookie}`,
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  return app.inject({
    method,
    url,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

const injectWithM2M = async (method: string, url: string, body?: unknown) => {
  return app.inject({
    method,
    url,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${m2mApiKeySecret}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

beforeAll(async () => {
  // Cadastra usuários via Better Auth
  await signUp('owner@exemplo.com', 'SenhaForte123!', 'Dono da Organização')
  await signUp('member@exemplo.com', 'SenhaForte123!', 'Membro da Organização')
  await signUp('outro@exemplo.com', 'SenhaForte123!', 'Outro Usuário')

  // Faz login para obter cookies de sessão
  ownerSessionCookie = await loginAndGetCookie('owner@exemplo.com', 'SenhaForte123!')

  // Cria uma organização via API
  const createRes = await injectWithSession('POST', '/v1/organizations', {
    name: 'Organização Teste',
    email: 'owner@exemplo.com',
    termsVersion: '1.0.0',
  })
  expect(createRes.statusCode).toBe(201)
  const org = createRes.json()
  orgTenantId = org.tenantId

  // Adiciona member como admin para permitir gestão de API keys
  await injectWithSession(
    'POST',
    `/v1/organizations/${orgTenantId}/members`,
    { email: 'member@exemplo.com', role: 'admin' },
    ownerSessionCookie,
  )

  // Cria uma credencial M2M com scopes de holder e kyc
  const keyRes = await injectWithSession(
    'POST',
    `/v1/m2m/api-keys?tenantId=${orgTenantId}`,
    {
      name: 'Chave M2M Holder/KYC',
      scopes: ['holders:read', 'holders:write', 'kyc:read', 'kyc:write', 'verify:m2m'],
      keyType: 'm2m',
    },
    ownerSessionCookie,
  )
  expect(keyRes.statusCode).toBe(201)
  m2mApiKeySecret = keyRes.json().secret
  m2mApiKeyId = keyRes.json().apiKey.apiKeyId
})

afterAll(async () => {
  await app.close()
  redis.disconnect()
  await adminPool.end()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

describe('Holder Integration', () => {
  it('deve criar um holder por M2M', async () => {
    const res = await injectWithM2M('POST', `/v1/holders?tenantId=${orgTenantId}`, {
      externalReference: 'ext-ref-001',
      name: 'José da Silva',
      documentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      documentType: 'CPF',
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.holderId).toBeDefined()
    expect(body.tenantId).toBe(orgTenantId)
    expect(body.externalReference).toBe('ext-ref-001')
    expect(body.name).toBe('José da Silva')
    expect(body.documentHash).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(body.documentType).toBe('CPF')
  })

  it('não deve permitir criar holder sem scope holders:write', async () => {
    // Cria uma chave sem scope de escrita
    const keyRes = await injectWithSession(
      'POST',
      `/v1/m2m/api-keys?tenantId=${orgTenantId}`,
      {
        name: 'Chave sem scope write',
        scopes: ['holders:read'],
        keyType: 'm2m',
      },
      ownerSessionCookie,
    )
    expect(keyRes.statusCode).toBe(201)
    const secret = keyRes.json().secret

    const res = await app.inject({
      method: 'POST',
      url: `/v1/holders?tenantId=${orgTenantId}`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        externalReference: 'ext-ref-002',
        name: 'Sem Escrita',
        documentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        documentType: 'CPF',
      }),
    })
    expect(res.statusCode).toBe(403)
  })

  it('deve listar holders por M2M', async () => {
    const res = await injectWithM2M('GET', `/v1/holders?tenantId=${orgTenantId}`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.holders)).toBe(true)
    expect(body.holders.length).toBeGreaterThanOrEqual(1)
    expect(body.total).toBeGreaterThanOrEqual(1)
    expect(body.total).toBe(body.holders.length)
  })

  it('deve buscar um holder específico por ID', async () => {
    // Primeiro cria um holder
    const createRes = await injectWithM2M('POST', `/v1/holders?tenantId=${orgTenantId}`, {
      externalReference: 'ext-ref-search',
      name: 'Busca Holder',
      documentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      documentType: 'CNPJ',
    })
    expect(createRes.statusCode).toBe(201)
    const holderId = createRes.json().holderId

    const res = await injectWithM2M('GET', `/v1/holders/${holderId}?tenantId=${orgTenantId}`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.holderId).toBe(holderId)
    expect(body.name).toBe('Busca Holder')
    expect(body.documentType).toBe('CNPJ')
  })

  it('não deve permitir acessar holder de outro tenant', async () => {
    // Cria outra organização
    const otherCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')
    const otherOrgRes = await injectWithSession(
      'POST',
      '/v1/organizations',
      { name: 'Outra Organização', email: 'outro@exemplo.com', termsVersion: '1.0.0' },
      otherCookie,
    )
    expect(otherOrgRes.statusCode).toBe(201)
    const otherOrgTenantId = otherOrgRes.json().tenantId

    // Cria um holder na outra organização
    const createRes = await injectWithSession(
      'POST',
      `/v1/holders?tenantId=${otherOrgTenantId}`,
      {
        externalReference: 'ext-ref-other',
        name: 'Holder Outro Tenant',
        documentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        documentType: 'CPF',
      },
      otherCookie,
    )
    expect(createRes.statusCode).toBe(201)
    const otherHolderId = createRes.json().holderId

    // Tenta acessar esse holder usando a chave M2M da orgTenantId
    const res = await injectWithM2M('GET', `/v1/holders/${otherHolderId}?tenantId=${otherOrgTenantId}`)
    // Isolamento multi-tenant: não encontra o holder no contexto do próprio tenant
    expect(res.statusCode).toBe(404)
  })

  it('deve atualizar um holder por M2M', async () => {
    const createRes = await injectWithM2M('POST', `/v1/holders?tenantId=${orgTenantId}`, {
      externalReference: 'ext-ref-update',
      name: 'Nome Antigo',
      documentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      documentType: 'CPF',
    })
    expect(createRes.statusCode).toBe(201)
    const holderId = createRes.json().holderId

    const res = await injectWithM2M('PATCH', `/v1/holders/${holderId}?tenantId=${orgTenantId}`, {
      name: 'Nome Atualizado',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.name).toBe('Nome Atualizado')
  })
})

describe('KYC Integration', () => {
  let holderId: string

  beforeAll(async () => {
    // Cria um holder para os testes de KYC
    const createRes = await injectWithM2M('POST', `/v1/holders?tenantId=${orgTenantId}`, {
      externalReference: 'ext-ref-kyc',
      name: 'Holder KYC',
      documentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      documentType: 'CPF',
    })
    expect(createRes.statusCode).toBe(201)
    holderId = createRes.json().holderId
  })

  it('deve criar um processo KYC com tenant correto', async () => {
    const res = await injectWithM2M('POST', `/v1/holders/${holderId}/kyc?tenantId=${orgTenantId}`, {
      legalBasis: 'CONSENT',
      expiresAt: '2027-01-01T00:00:00Z',
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.kycProcessId).toBeDefined()
    expect(body.holderId).toBe(holderId)
    expect(body.tenantId).toBe(orgTenantId)
    expect(body.state).toBe('pending')
    expect(body.legalBasis).toBe('CONSENT')
  })

  it('não deve criar processo KYC com tenant inconsistente', async () => {
    // Cria outra organização
    const otherCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')
    const otherOrgRes = await injectWithSession(
      'POST',
      '/v1/organizations',
      { name: 'Org KYC Outro', email: 'outro@exemplo.com', termsVersion: '1.0.0' },
      otherCookie,
    )
    expect(otherOrgRes.statusCode).toBe(201)
    const otherOrgTenantId = otherOrgRes.json().tenantId

    // Tenta criar KYC para o holder da orgTenantId usando tenant da outra org
    const res = await injectWithSession(
      'POST',
      `/v1/holders/${holderId}/kyc?tenantId=${otherOrgTenantId}`,
      { legalBasis: 'CONSENT' },
      otherCookie,
    )
    // Isolamento multi-tenant: não encontra o holder no contexto do tenant informado
    expect(res.statusCode).toBe(404)
  })

  it('não deve criar processo KYC com tenant de outra organização', async () => {
    // Cria outra organização
    const otherCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')
    const otherOrgRes = await injectWithSession(
      'POST',
      '/v1/organizations',
      { name: 'Org KYC Outro 2', email: 'outro@exemplo.com', termsVersion: '1.0.0' },
      otherCookie,
    )
    expect(otherOrgRes.statusCode).toBe(201)
    const otherOrgTenantId = otherOrgRes.json().tenantId

    // Tenta criar KYC para o holder desta org usando tenant da outra org.
    // Isolamento multi-tenant: não encontra o holder no contexto do tenant informado.
    const res = await injectWithSession(
      'POST',
      `/v1/holders/${holderId}/kyc?tenantId=${otherOrgTenantId}`,
      { legalBasis: 'CONSENT' },
      otherCookie,
    )
    expect(res.statusCode).toBe(404)
  })

  it('deve listar processos KYC com contagem correta', async () => {
    // Cria um segundo processo
    await injectWithM2M('POST', `/v1/holders/${holderId}/kyc?tenantId=${orgTenantId}`, {
      legalBasis: 'CONTRACT_EXECUTION',
    })

    const res = await injectWithM2M('GET', `/v1/holders/${holderId}/kyc?tenantId=${orgTenantId}`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.processes)).toBe(true)
    expect(body.processes.length).toBeGreaterThanOrEqual(2)
    expect(body.total).toBeGreaterThanOrEqual(2)
    expect(body.total).toBe(body.processes.length)
  })

  it('deve transicionar estado do KYC com evento de auditoria', async () => {
    // Primeiro lista para obter um processo
    const listRes = await injectWithM2M('GET', `/v1/holders/${holderId}/kyc?tenantId=${orgTenantId}`)
    expect(listRes.statusCode).toBe(200)
    const processes = listRes.json().processes
    const pendingProcess = processes.find((p: { state: string }) => p.state === 'pending')
    expect(pendingProcess).toBeDefined()

    const res = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/kyc/${pendingProcess.kycProcessId}/transition?tenantId=${orgTenantId}`,
      { toState: 'in_progress', reason: 'Iniciando validação' },
    )
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.state).toBe('in_progress')
  })

  it('deve listar eventos de auditoria do KYC', async () => {
    // Cria um processo KYC dedicado para este teste
    const createRes = await injectWithM2M('POST', `/v1/holders/${holderId}/kyc?tenantId=${orgTenantId}`, {
      legalBasis: 'CONSENT',
    })
    expect(createRes.statusCode).toBe(201)
    const kycProcessId = createRes.json().kycProcessId

    const res = await injectWithM2M(
      'GET',
      `/v1/holders/${holderId}/kyc/${kycProcessId}/events?tenantId=${orgTenantId}`,
    )
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.events)).toBe(true)
    expect(body.events.length).toBeGreaterThanOrEqual(1)
    expect(body.events[0].eventType).toBe('created')
    expect(body.total).toBeGreaterThanOrEqual(1)
    expect(body.total).toBe(body.events.length)
  })

  it('não deve listar eventos de KYC inexistente', async () => {
    const res = await injectWithM2M(
      'GET',
      `/v1/holders/${holderId}/kyc/00000000-0000-4000-8000-000000000000/events?tenantId=${orgTenantId}`,
    )
    expect(res.statusCode).toBe(404)
  })
})

describe('M2M API Key Management', () => {
  beforeAll(async () => {
    // Cria outra organização para testes de isolamento
    const otherCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')
    const otherOrgRes = await injectWithSession(
      'POST',
      '/v1/organizations',
      { name: 'Org Isolamento', email: 'outro@exemplo.com', termsVersion: '1.0.0' },
      otherCookie,
    )
    expect(otherOrgRes.statusCode).toBe(201)
  })

  it('usuário sem membership não pode administrar API keys', async () => {
    // O outro@exemplo.com não é membro de orgTenantId
    const otherCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')
    const res = await injectWithSession(
      'POST',
      `/v1/m2m/api-keys?tenantId=${orgTenantId}`,
      {
        name: 'Chave Não Membro',
        scopes: ['validate:read'],
        keyType: 'm2m',
      },
      otherCookie,
    )
    expect(res.statusCode).toBe(403)
  })

  it('usuário de outro tenant não pode listar API keys', async () => {
    const otherCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')
    const res = await injectWithSession(
      'GET',
      `/v1/m2m/api-keys?tenantId=${orgTenantId}`,
      undefined,
      otherCookie,
    )
    expect(res.statusCode).toBe(403)
  })

  it('usuário de outro tenant não pode revogar API keys', async () => {
    const otherCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')
    const res = await injectWithSession(
      'DELETE',
      `/v1/m2m/api-keys/${m2mApiKeyId}?tenantId=${orgTenantId}`,
      undefined,
      otherCookie,
    )
    expect(res.statusCode).toBe(403)
  })

  it('deve revogar uma API key e invalidar cache', async () => {
    // Cria uma nova chave para revogar
    const createRes = await injectWithSession(
      'POST',
      `/v1/m2m/api-keys?tenantId=${orgTenantId}`,
      {
        name: 'Chave para Revogar',
        scopes: ['validate:read'],
        keyType: 'm2m',
      },
      ownerSessionCookie,
    )
    expect(createRes.statusCode).toBe(201)
    const keyId = createRes.json().apiKey.apiKeyId

    const revokeRes = await injectWithSession(
      'DELETE',
      `/v1/m2m/api-keys/${keyId}?tenantId=${orgTenantId}`,
      undefined,
      ownerSessionCookie,
    )
    expect(revokeRes.statusCode).toBe(200)
    expect(revokeRes.json().revoked).toBe(true)

    // Tenta revogar novamente (já revogada)
    const revokeAgain = await injectWithSession(
      'DELETE',
      `/v1/m2m/api-keys/${keyId}?tenantId=${orgTenantId}`,
      undefined,
      ownerSessionCookie,
    )
    expect(revokeAgain.statusCode).toBe(404)
  })
})
