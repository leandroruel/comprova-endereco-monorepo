import { createHmac } from 'node:crypto'
import { createDbPool, runMigrations } from '@comprova/db'
import { createLogger, createMetrics } from '@comprova/observability'
import { startTestDb, startTestRedis, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

const PEPPER = 'test-pepper-123'

/**
 * Calcula o documentHash como HMAC-SHA-256 com segredo derivado por tenant.
 *
 * Fluxo (conforme contrato em packages/contracts/src/holder.ts):
 * 1. tenantSecret = HMAC-SHA-256(globalSecret, tenantId)
 * 2. documentHash = HMAC-SHA-256(tenantSecret, documentoNormalizado)
 * 3. Resultado é string hexadecimal minúscula de 64 caracteres.
 *
 * Não armazena nem expõe segredos reais; apenas demonstra o comportamento esperado.
 */
function computeDocumentHash(documento: string, tenantId: string): string {
  const tenantSecret = createHmac('sha256', PEPPER).update(tenantId).digest('hex')
  return createHmac('sha256', tenantSecret).update(documento).digest('hex')
}

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

let ownerSessionCookie: string

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

const injectWithM2M = async (method: string, url: string, body?: unknown, secret?: string) => {
  return app.inject({
    method,
    url,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret ?? ''}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

const createOrganization = async (sessionCookie: string, name: string, email: string): Promise<string> => {
  const res = await injectWithSession(
    'POST',
    '/v1/organizations',
    {
      name,
      email,
      termsVersion: '1.0.0',
    },
    sessionCookie,
  )
  expect(res.statusCode).toBe(201)
  return res.json().tenantId
}

const addMember = async (
  sessionCookie: string,
  tenantId: string,
  email: string,
  role: 'member' | 'admin' | 'owner',
) => {
  const res = await injectWithSession(
    'POST',
    `/v1/organizations/${tenantId}/members`,
    { email, role },
    sessionCookie,
  )
  return res
}

const createM2mApiKey = async (
  sessionCookie: string,
  tenantId: string,
  name: string,
  scopes: string[],
  keyType: 'user' | 'm2m' = 'm2m',
) => {
  const res = await injectWithSession(
    'POST',
    `/v1/m2m/api-keys?tenantId=${tenantId}`,
    { name, scopes, keyType },
    sessionCookie,
  )
  if (res.statusCode !== 201) {
    console.log('CREATE KEY ERROR:', res.statusCode, res.body)
  }
  expect(res.statusCode).toBe(201)
  return { secret: res.json().secret, apiKeyId: res.json().apiKey.apiKeyId }
}

beforeAll(async () => {
  // Cadastra usuários via Better Auth
  await signUp('owner@exemplo.com', 'SenhaForte123!', 'Dono da Organização')
  await signUp('member@exemplo.com', 'SenhaForte123!', 'Membro da Organização')
  await signUp('outro@exemplo.com', 'SenhaForte123!', 'Outro Usuário')

  // Faz login para obter cookies de sessão
  ownerSessionCookie = await loginAndGetCookie('owner@exemplo.com', 'SenhaForte123!')
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
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Holder M2M', 'owner@exemplo.com')

    // Adiciona owner como admin para gerenciar chaves (o criador já é owner)
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave M2M Holder', [
      'holders:read',
      'holders:write',
      'kyc:read',
      'kyc:write',
      'verify:m2m',
    ])

    const documento = '12345678901'
    const documentHash = computeDocumentHash(documento, tenantId)

    const res = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-001',
        name: 'José da Silva',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.holderId).toBeDefined()
    expect(body.tenantId).toBe(tenantId)
    expect(body.externalReference).toBe('ext-ref-001')
    expect(body.name).toBe('José da Silva')
    expect(body.documentHash).toBe(documentHash)
    expect(body.documentType).toBe('CPF')
  })

  it('não deve permitir criar holder sem scope holders:write', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Sem Escopo', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    // Chave com verify:m2m e holders:read, MAS SEM holders:write
    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave sem holders:write', [
      'holders:read',
      'verify:m2m',
    ])

    const documento = '12345678901'
    const documentHash = computeDocumentHash(documento, tenantId)

    const res = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-sem-write',
        name: 'Sem Escrita',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(res.statusCode).toBe(403)
  })

  it('deve listar holders por M2M com contagem real', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Listagem', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Listagem', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const documento = '12345678901'
    const documentHash = computeDocumentHash(documento, tenantId)

    // Cria 3 holders
    for (let i = 0; i < 3; i++) {
      await injectWithM2M(
        'POST',
        `/v1/holders?tenantId=${tenantId}`,
        {
          externalReference: `ext-ref-list-${i}`,
          name: `Holder ${i}`,
          documentHash,
          documentType: 'CPF',
        },
        key.secret,
      )
    }

    const res = await injectWithM2M('GET', `/v1/holders?tenantId=${tenantId}`, undefined, key.secret)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.holders)).toBe(true)
    expect(body.holders.length).toBe(3)
    expect(body.total).toBe(3)
    expect(body.total).toBe(body.holders.length)
  })

  it('deve buscar um holder específico por ID', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Busca', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Busca', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const documento = '12345678901'
    const documentHash = computeDocumentHash(documento, tenantId)

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-search',
        name: 'Holder Busca',
        documentHash,
        documentType: 'CNPJ',
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const holderId = createRes.json().holderId

    const res = await injectWithM2M(
      'GET',
      `/v1/holders/${holderId}?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.holderId).toBe(holderId)
    expect(body.name).toBe('Holder Busca')
    expect(body.documentType).toBe('CNPJ')
  })

  it('não deve permitir acessar holder de outro tenant (isolamento)', async () => {
    const ownerCookie = ownerSessionCookie
    const outroCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')

    // Organização do outro usuário
    const outroTenantId = await createOrganization(outroCookie, 'Org Outro Tenant', 'outro@exemplo.com')
    await addMember(outroCookie, outroTenantId, 'outro@exemplo.com', 'admin')
    const outroKey = await createM2mApiKey(outroCookie, outroTenantId, 'Chave Outro Tenant', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    // Cria holder na organização do outro
    const documento = '12345678901'
    const documentHashOutro = computeDocumentHash(documento, outroTenantId)

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${outroTenantId}`,
      {
        externalReference: 'ext-ref-outro',
        name: 'Holder Outro Tenant',
        documentHash: documentHashOutro,
        documentType: 'CPF',
      },
      outroKey.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const otherHolderId = createRes.json().holderId

    // Chave M2M da org principal tenta acessar holder da outra org
    const ownerTenantId = await createOrganization(ownerCookie, 'Org Principal', 'owner@exemplo.com')
    await addMember(ownerCookie, ownerTenantId, 'owner@exemplo.com', 'admin')
    const ownerKey = await createM2mApiKey(ownerCookie, ownerTenantId, 'Chave Principal', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    // Usa tenantId da outra org mas com chave da org principal - deve ser rejeitado
    const res = await injectWithM2M(
      'GET',
      `/v1/holders/${otherHolderId}?tenantId=${outroTenantId}`,
      undefined,
      ownerKey.secret,
    )
    // Isolamento multi-tenant: chave de um tenant não acessa dados de outro
    expect(res.statusCode).toBe(403)
  })

  it('deve atualizar um holder por M2M', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Atualiza', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Atualiza', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const documento = '12345678901'
    const documentHash = computeDocumentHash(documento, tenantId)

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-update',
        name: 'Nome Antigo',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const holderId = createRes.json().holderId

    const res = await injectWithM2M(
      'PATCH',
      `/v1/holders/${holderId}?tenantId=${tenantId}`,
      { name: 'Nome Atualizado' },
      key.secret,
    )
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.name).toBe('Nome Atualizado')
  })

  it('deve rejeitar criação de holder com externalReference duplicado no mesmo tenant (409)', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Duplicata', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Duplicata', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const documento = '12345678901'
    const documentHash = computeDocumentHash(documento, tenantId)

    // Primeira criação
    const res1 = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-duplicado',
        name: 'Primeiro',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(res1.statusCode).toBe(201)

    // Segunda criação com mesmo externalReference no mesmo tenant
    const res2 = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-duplicado',
        name: 'Segundo',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(res2.statusCode).toBe(409)
    expect(res2.json().code).toBe('HOLDER_ALREADY_EXISTS')
  })

  it('deve permitir o mesmo externalReference em tenants diferentes', async () => {
    const tenantA = await createOrganization(ownerSessionCookie, 'Org Tenant A', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantA, 'owner@exemplo.com', 'admin')
    const keyA = await createM2mApiKey(ownerSessionCookie, tenantA, 'Chave Tenant A', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const tenantB = await createOrganization(ownerSessionCookie, 'Org Tenant B', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantB, 'owner@exemplo.com', 'admin')
    const keyB = await createM2mApiKey(ownerSessionCookie, tenantB, 'Chave Tenant B', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    // Mesmo documento em tenants diferentes deve produzir documentHash diferente
    const documento = '12345678901'
    const documentHashA = computeDocumentHash(documento, tenantA)
    const documentHashB = computeDocumentHash(documento, tenantB)
    expect(documentHashA).not.toBe(documentHashB)

    // Mesmo externalReference em tenants diferentes deve ser permitido
    const resA = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantA}`,
      {
        externalReference: 'ext-ref-compartilhado',
        name: 'Holder Tenant A',
        documentHash: documentHashA,
        documentType: 'CPF',
      },
      keyA.secret,
    )
    expect(resA.statusCode).toBe(201)

    const resB = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantB}`,
      {
        externalReference: 'ext-ref-compartilhado',
        name: 'Holder Tenant B',
        documentHash: documentHashB,
        documentType: 'CPF',
      },
      keyB.secret,
    )
    expect(resB.statusCode).toBe(201)

    // Ambos existem independentemente
    expect(resA.json().tenantId).toBe(tenantA)
    expect(resB.json().tenantId).toBe(tenantB)
    expect(resA.json().externalReference).toBe('ext-ref-compartilhado')
    expect(resB.json().externalReference).toBe('ext-ref-compartilhado')
    expect(resA.json().documentHash).toBe(documentHashA)
    expect(resB.json().documentHash).toBe(documentHashB)
  })
})

describe('KYC Integration', () => {
  it('deve criar um processo KYC com tenant correto e evento de auditoria', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org KYC', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave KYC', [
      'holders:read',
      'holders:write',
      'kyc:read',
      'kyc:write',
      'verify:m2m',
    ])

    // Cria holder dedicado para este teste
    const documento = '12345678901'
    const documentHash = computeDocumentHash(documento, tenantId)

    // Cria holder dedicado para este teste
    const holderRes = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-holder-kyc',
        name: 'Holder KYC',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(holderRes.statusCode).toBe(201)
    const holderId = holderRes.json().holderId

    // Cria processo KYC
    const res = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/kyc?tenantId=${tenantId}`,
      {
        legalBasis: 'CONSENT',
        expiresAt: '2027-01-01T00:00:00Z',
      },
      key.secret,
    )
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.kycProcessId).toBeDefined()
    expect(body.holderId).toBe(holderId)
    expect(body.tenantId).toBe(tenantId)
    expect(body.state).toBe('pending')
    expect(body.legalBasis).toBe('CONSENT')

    // Verifica que o evento de auditoria 'created' foi persistido
    const eventsRes = await injectWithM2M(
      'GET',
      `/v1/holders/${holderId}/kyc/${body.kycProcessId}/events?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(eventsRes.statusCode).toBe(200)
    const events = eventsRes.json()
    expect(Array.isArray(events.events)).toBe(true)
    expect(events.events.length).toBeGreaterThanOrEqual(1)
    expect(events.events[0].eventType).toBe('created')
    expect(events.events[0].toState).toBe('pending')
  })

  it('não deve criar processo KYC quando holder não pertence ao tenant informado', async () => {
    const tenantIdA = await createOrganization(ownerSessionCookie, 'Org KYC A', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantIdA, 'owner@exemplo.com', 'admin')
    const keyA = await createM2mApiKey(ownerSessionCookie, tenantIdA, 'Chave KYC A', [
      'holders:read',
      'holders:write',
      'kyc:read',
      'kyc:write',
      'verify:m2m',
    ])

    const tenantIdB = await createOrganization(ownerSessionCookie, 'Org KYC B', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantIdB, 'owner@exemplo.com', 'admin')
    const keyB = await createM2mApiKey(ownerSessionCookie, tenantIdB, 'Chave KYC B', [
      'holders:read',
      'holders:write',
      'kyc:read',
      'kyc:write',
      'verify:m2m',
    ])

    // Cria holder na org A
    const documento = '12345678901'
    const documentHashA = computeDocumentHash(documento, tenantIdA)

    const holderRes = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantIdA}`,
      {
        externalReference: 'ext-ref-holder-a',
        name: 'Holder Org A',
        documentHash: documentHashA,
        documentType: 'CPF',
      },
      keyA.secret,
    )
    expect(holderRes.statusCode).toBe(201)
    const holderId = holderRes.json().holderId

    // Tenta criar KYC no tenant B para o holder da org A
    const res = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/kyc?tenantId=${tenantIdB}`,
      { legalBasis: 'CONSENT' },
      keyB.secret,
    )
    // Isolamento: holder não pertence ao tenant B
    expect(res.statusCode).toBe(404)
  })

  it('deve listar processos KYC com contagem real', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org KYC Listagem', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave KYC Listagem', [
      'holders:read',
      'holders:write',
      'kyc:read',
      'kyc:write',
      'verify:m2m',
    ])

    const documento = '12345678901'
    const documentHash = computeDocumentHash(documento, tenantId)

    const holderRes = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-holder-list',
        name: 'Holder Listagem',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(holderRes.statusCode).toBe(201)
    const holderId = holderRes.json().holderId

    // Cria 3 processos KYC
    for (let i = 0; i < 3; i++) {
      await injectWithM2M(
        'POST',
        `/v1/holders/${holderId}/kyc?tenantId=${tenantId}`,
        { legalBasis: 'CONSENT' },
        key.secret,
      )
    }

    const res = await injectWithM2M(
      'GET',
      `/v1/holders/${holderId}/kyc?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.processes)).toBe(true)
    expect(body.processes.length).toBe(3)
    expect(body.total).toBe(3)
    expect(body.total).toBe(body.processes.length)
  })

  it('deve transicionar estado do KYC com evento de auditoria', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org KYC Transicao', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave KYC Transicao', [
      'holders:read',
      'holders:write',
      'kyc:read',
      'kyc:write',
      'verify:m2m',
    ])

    const documento = '12345678901'
    const documentHash = computeDocumentHash(documento, tenantId)

    const holderRes = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-holder-transicao',
        name: 'Holder Transicao',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(holderRes.statusCode).toBe(201)
    const holderId = holderRes.json().holderId

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/kyc?tenantId=${tenantId}`,
      { legalBasis: 'CONSENT' },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const kycProcessId = createRes.json().kycProcessId

    const res = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/kyc/${kycProcessId}/transition?tenantId=${tenantId}`,
      { toState: 'in_progress', reason: 'Iniciando validação' },
      key.secret,
    )
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.state).toBe('in_progress')

    // Verifica evento de transição de auditoria
    const eventsRes = await injectWithM2M(
      'GET',
      `/v1/holders/${holderId}/kyc/${kycProcessId}/events?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(eventsRes.statusCode).toBe(200)
    const events = eventsRes.json().events
    const transitionEvent = events.find((e: { eventType: string }) => e.eventType === 'state_transitioned')
    expect(transitionEvent).toBeDefined()
    expect(transitionEvent.toState).toBe('in_progress')
    expect(transitionEvent.fromState).toBe('pending')
  })

  it('deve retornar 409 em transição KYC concorrente', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org KYC Concorrencia', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave KYC Concorrencia', [
      'holders:read',
      'holders:write',
      'kyc:read',
      'kyc:write',
      'verify:m2m',
    ])

    const documento = '12345678901'
    const documentHash = computeDocumentHash(documento, tenantId)

    const holderRes = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-holder-concorrencia',
        name: 'Holder Concorrencia',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(holderRes.statusCode).toBe(201)
    const holderId = holderRes.json().holderId

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/kyc?tenantId=${tenantId}`,
      { legalBasis: 'CONSENT' },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const kycProcessId = createRes.json().kycProcessId

    // Duas transições concorrentes para o mesmo estado (in_progress)
    const results = await Promise.all([
      injectWithM2M(
        'POST',
        `/v1/holders/${holderId}/kyc/${kycProcessId}/transition?tenantId=${tenantId}`,
        { toState: 'in_progress', reason: 'Primeira' },
        key.secret,
      ),
      injectWithM2M(
        'POST',
        `/v1/holders/${holderId}/kyc/${kycProcessId}/transition?tenantId=${tenantId}`,
        { toState: 'in_progress', reason: 'Segunda' },
        key.secret,
      ),
    ])

    // Apenas uma deve ser efetivada (200), a outra deve falhar com 409
    const statuses = results.map((r) => r.statusCode).sort()
    expect(statuses).toEqual([200, 409])

    // Identificar qual requisição retornou 200
    const successResult = results.find((r) => r.statusCode === 200)
    expect(successResult).toBeDefined()
    expect(successResult!.json().state).toBe('in_progress')

    const winnerIndex = results.findIndex((r) => r.statusCode === 200)
    const winnerReason = winnerIndex === 0 ? 'Primeira' : 'Segunda'

    const eventsRes = await injectWithM2M(
      'GET',
      `/v1/holders/${holderId}/kyc/${kycProcessId}/events?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(eventsRes.statusCode).toBe(200)
    const events = eventsRes.json().events
    const transitionEvents = events.filter((e: { eventType: string }) => e.eventType === 'state_transitioned')
    expect(transitionEvents.length).toBe(1)
    expect(transitionEvents[0].toState).toBe('in_progress')
    const details =
      typeof transitionEvents[0].details === 'string'
        ? JSON.parse(transitionEvents[0].details as string)
        : transitionEvents[0].details
    expect(details.reason).toBe(winnerReason)
  })

  it('deve listar eventos de auditoria do KYC', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org KYC Eventos', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave KYC Eventos', [
      'holders:read',
      'holders:write',
      'kyc:read',
      'kyc:write',
      'verify:m2m',
    ])

    const documento = '12345678901'
    const documentHash = computeDocumentHash(documento, tenantId)

    const holderRes = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-holder-eventos',
        name: 'Holder Eventos',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(holderRes.statusCode).toBe(201)
    const holderId = holderRes.json().holderId

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/kyc?tenantId=${tenantId}`,
      { legalBasis: 'CONSENT' },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const kycProcessId = createRes.json().kycProcessId

    const res = await injectWithM2M(
      'GET',
      `/v1/holders/${holderId}/kyc/${kycProcessId}/events?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.events)).toBe(true)
    expect(body.events.length).toBeGreaterThanOrEqual(1)
    expect(body.events[0].eventType).toBe('created')
    expect(body.total).toBeGreaterThanOrEqual(1)
    expect(body.total).toBe(body.events.length)
  })

  it('não deve listar eventos de KYC inexistente (404)', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org KYC Sem Processo', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave KYC Sem Processo', [
      'holders:read',
      'holders:write',
      'kyc:read',
      'kyc:write',
      'verify:m2m',
    ])

    const res = await injectWithM2M(
      'GET',
      `/v1/holders/00000000-0000-4000-8000-000000000000/kyc/00000000-0000-4000-8000-000000000000/events?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(res.statusCode).toBe(404)
  })
})

describe('M2M API Key Management - Autorização por Membership', () => {
  it('usuário sem membership não pode criar API key (403)', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Sem Membership', 'owner@exemplo.com')

    // Outro usuário não é membro desta organização
    const outroCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')

    const res = await injectWithSession(
      'POST',
      `/v1/m2m/api-keys?tenantId=${tenantId}`,
      {
        name: 'Chave Sem Membership',
        scopes: ['validate:read'],
        keyType: 'm2m',
      },
      outroCookie,
    )
    expect(res.statusCode).toBe(403)
  })

  it('membro comum (não admin/owner) não pode criar API key (403)', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Membro Comum', 'owner@exemplo.com')

    // Adiciona outro usuário como membro simples (não admin)
    const outroCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')
    await addMember(ownerSessionCookie, tenantId, 'outro@exemplo.com', 'member')

    const res = await injectWithSession(
      'POST',
      `/v1/m2m/api-keys?tenantId=${tenantId}`,
      {
        name: 'Chave Membro Comum',
        scopes: ['validate:read'],
        keyType: 'm2m',
      },
      outroCookie,
    )
    expect(res.statusCode).toBe(403)
  })

  it('admin consegue criar e revogar API key', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Admin', 'owner@exemplo.com')

    // Adiciona outro usuário como admin
    const adminCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')
    await addMember(ownerSessionCookie, tenantId, 'outro@exemplo.com', 'admin')

    // Admin cria API key
    const createRes = await injectWithSession(
      'POST',
      `/v1/m2m/api-keys?tenantId=${tenantId}`,
      {
        name: 'Chave do Admin',
        scopes: ['validate:read'],
        keyType: 'm2m',
      },
      adminCookie,
    )
    expect(createRes.statusCode).toBe(201)
    const keyId = createRes.json().apiKey.apiKeyId

    // Admin revoga API key
    const revokeRes = await injectWithSession(
      'DELETE',
      `/v1/m2m/api-keys/${keyId}?tenantId=${tenantId}`,
      undefined,
      adminCookie,
    )
    expect(revokeRes.statusCode).toBe(200)
    expect(revokeRes.json().revoked).toBe(true)
  })

  it('membro comum não consegue revogar API key (403)', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Membro Revoga', 'owner@exemplo.com')

    // Owner cria uma API key
    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave para Revogar', ['validate:read'])

    // Adiciona outro usuário como membro simples
    const membroCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')
    await addMember(ownerSessionCookie, tenantId, 'outro@exemplo.com', 'member')

    // Membro simples tenta revogar
    const res = await injectWithSession(
      'DELETE',
      `/v1/m2m/api-keys/${key.apiKeyId}?tenantId=${tenantId}`,
      undefined,
      membroCookie,
    )
    expect(res.statusCode).toBe(403)
  })

  it('admin e membros autorizados conseguem listar API keys', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Lista Chaves', 'owner@exemplo.com')

    // Owner cria algumas API keys
    await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave 1', ['validate:read'])
    await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave 2', ['validate:read'])

    // Owner consegue listar
    const ownerRes = await injectWithSession(
      'GET',
      `/v1/m2m/api-keys?tenantId=${tenantId}`,
      undefined,
      ownerSessionCookie,
    )
    expect(ownerRes.statusCode).toBe(200)
    expect(ownerRes.json().apiKeys.length).toBeGreaterThanOrEqual(2)

    // Adiciona admin e consegue listar
    const adminCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')
    await addMember(ownerSessionCookie, tenantId, 'outro@exemplo.com', 'admin')

    const adminRes = await injectWithSession(
      'GET',
      `/v1/m2m/api-keys?tenantId=${tenantId}`,
      undefined,
      adminCookie,
    )
    expect(adminRes.statusCode).toBe(200)
    expect(adminRes.json().apiKeys.length).toBeGreaterThanOrEqual(2)
  })

  it('Bearer token não consegue administrar API keys (401)', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Bearer Sem Sessao',
      'owner@exemplo.com',
    )

    // Cria uma chave M2M via sessão
    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave M2M', ['validate:read'])

    // Tenta usar a chave M2M via Bearer para criar outra chave (deve falhar - precisa de sessão)
    const res = await injectWithM2M(
      'POST',
      `/v1/m2m/api-keys?tenantId=${tenantId}`,
      {
        name: 'Chave via Bearer',
        scopes: ['validate:read'],
        keyType: 'm2m',
      },
      key.secret,
    )
    // Sessão de usuário é obrigatória para administrar API keys
    expect([401, 403]).toContain(res.statusCode)
  })

  it('usuário de outro tenant não consegue acessar dados ou administrar chaves', async () => {
    const tenantIdA = await createOrganization(ownerSessionCookie, 'Org Isolada A', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantIdA, 'owner@exemplo.com', 'admin')

    // Cria outra organização com outro usuário (não é membro da org A)
    const outroCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')
    const tenantIdB = await createOrganization(outroCookie, 'Org Isolada B', 'outro@exemplo.com')
    await addMember(outroCookie, tenantIdB, 'outro@exemplo.com', 'admin')

    // Cria chave na org A
    const keyA = await createM2mApiKey(ownerSessionCookie, tenantIdA, 'Chave Org A', ['validate:read'])

    // Usuário da org B (outroCookie) tenta listar chaves da org A - não é membro da org A
    const resB = await injectWithSession(
      'GET',
      `/v1/m2m/api-keys?tenantId=${tenantIdA}`,
      undefined,
      outroCookie,
    )
    expect(resB.statusCode).toBe(403)

    // Usuário da org B tenta revogar chave da org A
    const resRevoke = await injectWithSession(
      'DELETE',
      `/v1/m2m/api-keys/${keyA.apiKeyId}?tenantId=${tenantIdA}`,
      undefined,
      outroCookie,
    )
    expect(resRevoke.statusCode).toBe(403)
  })
})

describe('Holder/KYC - Autenticação Bearer Restrita', () => {
  it('sessão válida acessa endpoints Holder/KYC', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Sessao', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Sessao', [
      'holders:read',
      'holders:write',
      'kyc:read',
      'kyc:write',
      'verify:m2m',
    ])

    const documento = '12345678901'
    const documentHash = computeDocumentHash(documento, tenantId)

    // Cria holder via M2M
    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-sessao',
        name: 'Holder Sessao',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const holderId = createRes.json().holderId

    // Sessão autenticada consegue acessar o holder
    const res = await injectWithSession(
      'GET',
      `/v1/holders/${holderId}?tenantId=${tenantId}`,
      undefined,
      ownerSessionCookie,
    )
    expect(res.statusCode).toBe(200)
    expect(res.json().holderId).toBe(holderId)
  })

  it('chave M2M com verify:m2m e scope funcional consegue acessar Holder/KYC', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org M2M OK', 'owner@exemplo.com')
    // O usuário que cria a organização já é owner

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave M2M OK', [
      'holders:read',
      'holders:write',
      'kyc:read',
      'kyc:write',
      'verify:m2m',
    ])

    const documento = '12345678901'
    const documentHash = computeDocumentHash(documento, tenantId)

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-m2m-ok',
        name: 'Holder M2M OK',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const holderId = createRes.json().holderId

    // Chave M2M com verify:m2m e holders:read consegue ler
    const res = await injectWithM2M(
      'GET',
      `/v1/holders/${holderId}?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(res.statusCode).toBe(200)

    // Chave M2M com verify:m2m e kyc:write consegue criar KYC
    const kycRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/kyc?tenantId=${tenantId}`,
      { legalBasis: 'CONSENT' },
      key.secret,
    )
    expect(kycRes.statusCode).toBe(201)
  })

  it('chave M2M sem verify:m2m recebe 403 em Holder/KYC', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Sem Verify', 'owner@exemplo.com')
    // O usuário que cria a organização já é owner

    // Chave M2M sem verify:m2m, apenas holders:read
    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Sem Verify', ['holders:read'])

    const res = await injectWithM2M('GET', `/v1/holders?tenantId=${tenantId}`, undefined, key.secret)
    expect(res.statusCode).toBe(403)
  })

  it('chave M2M sem scope funcional recebe 403 em Holder/KYC', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Sem Scope', 'owner@exemplo.com')
    // O usuário que cria a organização já é owner

    // Chave M2M com verify:m2m mas SEM holders:read
    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Sem Scope', [
      'validate:read',
      'verify:m2m',
    ])

    const res = await injectWithM2M('GET', `/v1/holders?tenantId=${tenantId}`, undefined, key.secret)
    expect(res.statusCode).toBe(403)
  })

  it('chave user com holders:read não consegue acessar via Bearer', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org User Key', 'owner@exemplo.com')
    // O usuário que cria a organização já é owner

    // Chave user não pode ter scope holders:read - deve ser rejeitada na criação
    const res = await injectWithSession(
      'POST',
      `/v1/m2m/api-keys?tenantId=${tenantId}`,
      {
        name: 'Chave User',
        scopes: ['holders:read', 'keys:write'],
        keyType: 'user',
      },
      ownerSessionCookie,
    )
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_SCOPE')
  })

  it('chave user com holders:write não consegue acessar via Bearer', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org User Write', 'owner@exemplo.com')
    // O usuário que cria a organização já é owner

    const res = await injectWithSession(
      'POST',
      `/v1/m2m/api-keys?tenantId=${tenantId}`,
      {
        name: 'Chave User Write',
        scopes: ['holders:write', 'keys:write'],
        keyType: 'user',
      },
      ownerSessionCookie,
    )
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_SCOPE')
  })

  it('chave user com kyc:read ou kyc:write não consegue acessar via Bearer', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org User Kyc', 'owner@exemplo.com')
    // O usuário que cria a organização já é owner

    const res = await injectWithSession(
      'POST',
      `/v1/m2m/api-keys?tenantId=${tenantId}`,
      {
        name: 'Chave User Kyc',
        scopes: ['kyc:read', 'kyc:write', 'keys:write'],
        keyType: 'user',
      },
      ownerSessionCookie,
    )
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_SCOPE')
  })

  it('chave revogada não consegue acessar Holder/KYC', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Revogada', 'owner@exemplo.com')
    // O usuário que cria a organização já é owner

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Para Revogar', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const documento = '12345678901'
    const documentHash = computeDocumentHash(documento, tenantId)

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-revogada',
        name: 'Holder Revogada',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const holderId = createRes.json().holderId

    // Revoga a chave via sessão
    await injectWithSession(
      'DELETE',
      `/v1/m2m/api-keys/${key.apiKeyId}?tenantId=${tenantId}`,
      undefined,
      ownerSessionCookie,
    )

    // Chave revogada não consegue acessar
    const res = await injectWithM2M(
      'GET',
      `/v1/holders/${holderId}?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect([401, 403]).toContain(res.statusCode)
  })

  it('chave inválida não consegue acessar Holder/KYC', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Invalida', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const res = await injectWithM2M(
      'GET',
      `/v1/holders?tenantId=${tenantId}`,
      undefined,
      'chave-invalida-que-nao-existe',
    )
    expect([401, 403]).toContain(res.statusCode)
  })
})

describe('DocumentHash - Isolamento Criptográfico', () => {
  it('mesmo documento e mesmo tenant produzem identificador consistente', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Hash Consistencia',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Hash', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const documento = '12345678901'
    const documentHash = computeDocumentHash(documento, tenantId)

    const res1 = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-hash-1',
        name: 'Hash 1',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(res1.statusCode).toBe(201)

    const res2 = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-hash-2',
        name: 'Hash 2',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(res2.statusCode).toBe(201)

    expect(res1.json().documentHash).toBe(res2.json().documentHash)
    expect(res1.json().documentHash).toBe(documentHash)
  })

  it('mesmo documento em tenants diferentes produz identificadores independentes', async () => {
    const tenantA = await createOrganization(ownerSessionCookie, 'Org Hash A', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantA, 'owner@exemplo.com', 'admin')
    const keyA = await createM2mApiKey(ownerSessionCookie, tenantA, 'Chave Hash A', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const tenantB = await createOrganization(ownerSessionCookie, 'Org Hash B', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantB, 'owner@exemplo.com', 'admin')
    const keyB = await createM2mApiKey(ownerSessionCookie, tenantB, 'Chave Hash B', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    // Mesmo documento em tenants diferentes deve produzir documentHash diferente,
    // pois o segredo HMAC é derivado por tenant.
    const documento = '12345678901'
    const hashA = computeDocumentHash(documento, tenantA)
    const hashB = computeDocumentHash(documento, tenantB)
    expect(hashA).not.toBe(hashB)
    expect(hashA).toMatch(/^[0-9a-f]{64}$/)
    expect(hashB).toMatch(/^[0-9a-f]{64}$/)

    const resA = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantA}`,
      {
        externalReference: 'ext-ref-hash-a',
        name: 'Hash A',
        documentHash: hashA,
        documentType: 'CPF',
      },
      keyA.secret,
    )
    expect(resA.statusCode).toBe(201)

    const resB = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantB}`,
      {
        externalReference: 'ext-ref-hash-b',
        name: 'Hash B',
        documentHash: hashB,
        documentType: 'CPF',
      },
      keyB.secret,
    )
    expect(resB.statusCode).toBe(201)

    // Mesmo documento em tenants diferentes produz identificadores diferentes
    expect(resA.json().tenantId).toBe(tenantA)
    expect(resB.json().tenantId).toBe(tenantB)
    expect(resA.json().documentHash).toBe(hashA)
    expect(resB.json().documentHash).toBe(hashB)
    expect(resA.json().externalReference).not.toBe(resB.json().externalReference)
  })

  it('documentHash segue formato SHA-256 hex (64 caracteres)', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Hash Formato', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Formato', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const documento = '12345678901'
    const documentHash = computeDocumentHash(documento, tenantId)

    // documentHash válido: 64 caracteres hex
    const res = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-formato',
        name: 'Hash Formato',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(res.statusCode).toBe(201)
    expect(res.json().documentHash).toMatch(/^[0-9a-f]{64}$/)

    // documentHash inválido: não é hex
    const resInvalido = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-formato-invalido',
        name: 'Hash Invalido',
        documentHash: 'not-a-valid-hex-hash',
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(resInvalido.statusCode).toBe(400)
  })

  it('segredos não aparecem em respostas HTTP', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Sem Segredo', 'owner@exemplo.com')
    // O usuário que cria a organização já é owner

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Sem Segredo', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const documento = '12345678901'
    const documentHash = computeDocumentHash(documento, tenantId)

    const res = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-sem-segredo',
        name: 'Holder Sem Segredo',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(res.statusCode).toBe(201)

    const listRes = await injectWithM2M('GET', `/v1/holders?tenantId=${tenantId}`, undefined, key.secret)
    expect(listRes.statusCode).toBe(200)

    const body = JSON.stringify(listRes.json())
    // O segredo da chave M2M nunca deve aparecer nas respostas de holders
    expect(body).not.toContain(key.secret)
    // documentHash não deve conter o segredo em texto puro
    expect(listRes.json().holders[0].documentHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('KycEvent - Integridade Referencial Composta', () => {
  it('criar evento para processo pertencente ao mesmo tenant funciona', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Evento OK', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Evento OK', [
      'holders:read',
      'holders:write',
      'kyc:read',
      'kyc:write',
      'verify:m2m',
    ])

    const documento = '12345678901'
    const documentHash = computeDocumentHash(documento, tenantId)

    const holderRes = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-evento-ok',
        name: 'Holder Evento OK',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(holderRes.statusCode).toBe(201)
    const holderId = holderRes.json().holderId

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/kyc?tenantId=${tenantId}`,
      { legalBasis: 'CONSENT' },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const kycProcessId = createRes.json().kycProcessId

    // Listar eventos do processo - deve funcionar
    const res = await injectWithM2M(
      'GET',
      `/v1/holders/${holderId}/kyc/${kycProcessId}/events?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.events)).toBe(true)
    expect(body.events.length).toBeGreaterThanOrEqual(1)
  })

  it('consultas e listagens de eventos continuam funcionando', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Evento Lista', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Evento Lista', [
      'holders:read',
      'holders:write',
      'kyc:read',
      'kyc:write',
      'verify:m2m',
    ])

    const documento = '12345678901'
    const documentHash = computeDocumentHash(documento, tenantId)

    const holderRes = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference: 'ext-ref-evento-lista',
        name: 'Holder Evento Lista',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(holderRes.statusCode).toBe(201)
    const holderId = holderRes.json().holderId

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/kyc?tenantId=${tenantId}`,
      { legalBasis: 'CONSENT' },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const kycProcessId = createRes.json().kycProcessId

    // Transicionar para gerar mais eventos
    await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/kyc/${kycProcessId}/transition?tenantId=${tenantId}`,
      { toState: 'in_progress', reason: 'Iniciando' },
      key.secret,
    )

    // Listar eventos - deve funcionar com integridade referencial composta
    const res = await injectWithM2M(
      'GET',
      `/v1/holders/${holderId}/kyc/${kycProcessId}/events?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.events)).toBe(true)
    expect(body.events.length).toBeGreaterThanOrEqual(2) // created + state_transitioned
    expect(body.total).toBe(body.events.length)
  })
})

describe('M2M API Key - listApiKeys Autorização', () => {
  it('usuário sem membership tentando listar API keys recebe 403', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Sem Membership List',
      'owner@exemplo.com',
    )

    // Outro usuário não é membro desta organização
    const outroCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')

    const res = await injectWithSession(
      'GET',
      `/v1/m2m/api-keys?tenantId=${tenantId}`,
      undefined,
      outroCookie,
    )
    expect(res.statusCode).toBe(403)
  })

  it('membro autorizado consegue listar API keys', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Membro Lista', 'owner@exemplo.com')

    // Adiciona outro usuário como membro
    const outroCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')
    await addMember(ownerSessionCookie, tenantId, 'outro@exemplo.com', 'member')

    // Membro consegue listar
    const res = await injectWithSession(
      'GET',
      `/v1/m2m/api-keys?tenantId=${tenantId}`,
      undefined,
      outroCookie,
    )
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json().apiKeys)).toBe(true)
  })

  it('usuário sem permissão não consegue criar ou revogar API keys', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Sem Permissao', 'owner@exemplo.com')

    // Outro usuário não é membro
    const outroCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')

    // Não consegue criar
    const createRes = await injectWithSession(
      'POST',
      `/v1/m2m/api-keys?tenantId=${tenantId}`,
      {
        name: 'Chave Sem Permissao',
        scopes: ['validate:read'],
        keyType: 'm2m',
      },
      outroCookie,
    )
    expect(createRes.statusCode).toBe(403)

    // Não consegue revogar (criamos uma chave primeiro com o owner)
    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Para Testar', ['validate:read'])
    const revokeRes = await injectWithSession(
      'DELETE',
      `/v1/m2m/api-keys/${key.apiKeyId}?tenantId=${tenantId}`,
      undefined,
      outroCookie,
    )
    expect(revokeRes.statusCode).toBe(403)
  })

  it('Bearer token não consegue administrar API keys', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Bearer Lista', 'owner@exemplo.com')

    // Cria uma chave M2M via sessão
    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Bearer Lista', ['validate:read'])

    // Tenta listar chaves via Bearer (deve falhar - precisa de sessão)
    const res = await injectWithM2M('GET', `/v1/m2m/api-keys?tenantId=${tenantId}`, undefined, key.secret)
    expect([401, 403]).toContain(res.statusCode)
  })
})

describe('M2M API Keys - compatibilidade tenantId body vs query', () => {
  const setupOrg = async (email: string) => {
    await signUp(email, 'SenhaForte123!', 'Usuario BodyQuery')
    const cookie = await loginAndGetCookie(email, 'SenhaForte123!')
    const tenantId = await createOrganization(cookie, 'Org BodyQuery', email)
    return { cookie, tenantId }
  }

  const createKeyViaSession = async (
    cookie: string,
    tenantId: string,
    body: unknown,
    queryTenantId?: string,
  ) => {
    const url =
      queryTenantId === undefined ? `/v1/m2m/api-keys` : `/v1/m2m/api-keys?tenantId=${queryTenantId}`
    return injectWithSession('POST', url, body, cookie)
  }

  const revokeKeyViaSession = async (
    cookie: string,
    tenantId: string,
    apiKeyId: string,
    body: unknown,
    queryTenantId?: string,
  ) => {
    const url =
      queryTenantId === undefined
        ? `/v1/m2m/api-keys/${apiKeyId}`
        : `/v1/m2m/api-keys/${apiKeyId}?tenantId=${queryTenantId}`
    return injectWithSession('DELETE', url, body, cookie)
  }

  it('POST com tenantId somente no body é aceito (201)', async () => {
    const { cookie, tenantId } = await setupOrg('bodyquery@exemplo.com')

    const res = await createKeyViaSession(cookie, tenantId, {
      tenantId,
      name: 'Chave Body',
      scopes: ['validate:read'],
      keyType: 'm2m',
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().apiKey.tenantId).toBe(tenantId)
  })

  it('POST com tenantId somente na query é aceito (201)', async () => {
    const { cookie, tenantId } = await setupOrg('bodyquery2@exemplo.com')

    const res = await createKeyViaSession(
      cookie,
      tenantId,
      {
        name: 'Chave Query',
        scopes: ['validate:read'],
        keyType: 'm2m',
      },
      tenantId,
    )
    expect(res.statusCode).toBe(201)
    expect(res.json().apiKey.tenantId).toBe(tenantId)
  })

  it('POST com tenantId equivalente no body e na query é aceito (201)', async () => {
    const { cookie, tenantId } = await setupOrg('bodyquery3@exemplo.com')

    const res = await createKeyViaSession(
      cookie,
      tenantId,
      {
        tenantId,
        name: 'Chave Ambos',
        scopes: ['validate:read'],
        keyType: 'm2m',
      },
      tenantId,
    )
    expect(res.statusCode).toBe(201)
  })

  it('POST com tenantId divergente no body e na query responde 400', async () => {
    const { cookie, tenantId } = await setupOrg('bodyquery4@exemplo.com')

    const outroTenantId = await createOrganization(cookie, 'Org Outro', 'bodyquery4@exemplo.com')
    const res = await createKeyViaSession(
      cookie,
      tenantId,
      {
        tenantId: outroTenantId,
        name: 'Chave Divergente',
        scopes: ['validate:read'],
        keyType: 'm2m',
      },
      tenantId,
    )
    expect(res.statusCode).toBe(400)
  })

  it('POST sem tenantId nem no body nem na query responde 400', async () => {
    const { cookie, tenantId } = await setupOrg('bodyquery5@exemplo.com')

    const res = await createKeyViaSession(cookie, tenantId, {
      name: 'Chave Sem Tenant',
      scopes: ['validate:read'],
      keyType: 'm2m',
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST com tenantId inválido responde 400', async () => {
    const { cookie } = await setupOrg('bodyquery6@exemplo.com')

    const res = await createKeyViaSession(cookie, '', {
      tenantId: 'nao-e-um-uuid',
      name: 'Chave Invalida',
      scopes: ['validate:read'],
      keyType: 'm2m',
    })
    expect(res.statusCode).toBe(400)
  })

  it('DELETE com tenantId somente no body é aceito (200)', async () => {
    const { cookie, tenantId } = await setupOrg('bodyquery7@exemplo.com')

    const createRes = await createKeyViaSession(
      cookie,
      tenantId,
      {
        name: 'Chave Para Revogar Body',
        scopes: ['validate:read'],
        keyType: 'm2m',
      },
      tenantId,
    )
    expect(createRes.statusCode).toBe(201)
    const apiKeyId = createRes.json().apiKey.apiKeyId

    const res = await revokeKeyViaSession(cookie, tenantId, apiKeyId, { tenantId })
    expect(res.statusCode).toBe(200)
    expect(res.json().revoked).toBe(true)
  })

  it('DELETE com tenantId somente na query é aceito (200)', async () => {
    const { cookie, tenantId } = await setupOrg('bodyquery8@exemplo.com')

    const createRes = await createKeyViaSession(
      cookie,
      tenantId,
      {
        name: 'Chave Para Revogar Query',
        scopes: ['validate:read'],
        keyType: 'm2m',
      },
      tenantId,
    )
    expect(createRes.statusCode).toBe(201)
    const apiKeyId = createRes.json().apiKey.apiKeyId

    const res = await revokeKeyViaSession(cookie, tenantId, apiKeyId, undefined, tenantId)
    expect(res.statusCode).toBe(200)
    expect(res.json().revoked).toBe(true)
  })

  it('DELETE com tenantId divergente no body e na query responde 400', async () => {
    const { cookie, tenantId } = await setupOrg('bodyquery9@exemplo.com')

    const createRes = await createKeyViaSession(
      cookie,
      tenantId,
      {
        name: 'Chave Divergente Del',
        scopes: ['validate:read'],
        keyType: 'm2m',
      },
      tenantId,
    )
    expect(createRes.statusCode).toBe(201)
    const apiKeyId = createRes.json().apiKey.apiKeyId

    const outroTenantId = await createOrganization(cookie, 'Org Outro Del', 'bodyquery9@exemplo.com')
    const res = await revokeKeyViaSession(cookie, tenantId, apiKeyId, { tenantId: outroTenantId }, tenantId)
    expect(res.statusCode).toBe(400)
  })

  it('DELETE sem tenantId nem no body nem na query responde 400', async () => {
    const { cookie, tenantId } = await setupOrg('bodyquery10@exemplo.com')

    const createRes = await createKeyViaSession(
      cookie,
      tenantId,
      {
        name: 'Chave Sem Tenant Del',
        scopes: ['validate:read'],
        keyType: 'm2m',
      },
      tenantId,
    )
    expect(createRes.statusCode).toBe(201)
    const apiKeyId = createRes.json().apiKey.apiKeyId

    const res = await revokeKeyViaSession(cookie, tenantId, apiKeyId, undefined)
    expect(res.statusCode).toBe(400)
  })

  it('usuário sem membership não pode criar API key (403)', async () => {
    const { tenantId } = await setupOrg('bodyquery11@exemplo.com')
    const outroCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')

    const res = await createKeyViaSession(outroCookie, tenantId, {
      tenantId,
      name: 'Chave Sem Membership',
      scopes: ['validate:read'],
      keyType: 'm2m',
    })
    expect(res.statusCode).toBe(403)
  })

  it('usuário tentando acessar tenant ao qual não pertence recebe 403', async () => {
    const outroCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')

    const tenantIdA = await createOrganization(ownerSessionCookie, 'Org Alvo BodyQuery', 'owner@exemplo.com')

    // outro@exemplo.com não é membro da org A
    const res = await createKeyViaSession(outroCookie, tenantIdA, {
      tenantId: tenantIdA,
      name: 'Chave Invasora',
      scopes: ['validate:read'],
      keyType: 'm2m',
    })
    expect(res.statusCode).toBe(403)
  })
})
