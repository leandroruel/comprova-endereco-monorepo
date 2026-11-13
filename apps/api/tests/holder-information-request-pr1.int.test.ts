import { createHmac } from 'node:crypto'
import { createDbPool, runMigrations } from '@comprova/db'
import { createLogger, createMetrics } from '@comprova/observability'
import { startTestDb, startTestRedis, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

const PEPPER = 'test-pepper-123'

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
  const match = cookieHeader.match(/legacy-auth\.session_token=([^;]+)/)
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
    Cookie: `legacy-auth.session_token=${sessionCookie}`,
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
  expect(res.statusCode).toBe(201)
  return { secret: res.json().secret, apiKeyId: res.json().apiKey.apiKeyId }
}

const createHolder = async (
  sessionCookieOrKey: string | { secret: string },
  tenantId: string,
  externalReference: string,
  useM2M = false,
): Promise<string> => {
  const documento = '12345678901'
  const documentHash = computeDocumentHash(documento, tenantId)
  if (useM2M) {
    const key = sessionCookieOrKey as { secret: string }
    const res = await injectWithM2M(
      'POST',
      `/v1/holders?tenantId=${tenantId}`,
      {
        externalReference,
        name: 'Titular Teste',
        documentHash,
        documentType: 'CPF',
      },
      key.secret,
    )
    expect(res.statusCode).toBe(201)
    return res.json().holderId
  }
  const cookie = sessionCookieOrKey as string
  const res = await injectWithSession(
    'POST',
    `/v1/holders?tenantId=${tenantId}`,
    {
      externalReference,
      name: 'Titular Teste',
      documentHash,
      documentType: 'CPF',
    },
    cookie,
  )
  expect(res.statusCode).toBe(201)
  return res.json().holderId
}

const createValidation = async (sessionCookie?: string): Promise<string> => {
  const cookie = sessionCookie ?? ownerSessionCookie
  const body = {
    document: { type: 'CPF' as const, value: '12345678901' },
    address: {
      tipo_logradouro: 'Rua',
      logradouro: 'das Flores',
      numero: '123',
      bairro: 'Centro',
      cep: '01001000',
      uf: 'SP',
      municipio: 'São Paulo',
      country_code: 'BR',
    },
    legal_basis: 'CONSENT' as const,
    consent_ref: 'consent-123',
  } as any
  // A criação de Validation exige escopo de escrita (`validations:write`),
  // que não está disponível em uma M2M key restrita apenas a holders.
  // Usamos a sessão de usuário autenticado, que detém os escopos necessários.
  const res = await injectWithSession('POST', '/v1/validations', body, cookie)
  expect(res.statusCode).toBe(201)
  return res.json().validation_id
}

beforeAll(async () => {
  await signUp('owner@exemplo.com', 'SenhaForte123!', 'Dono da Organização')
  await signUp('outro@exemplo.com', 'SenhaForte123!', 'Outro Usuário')
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

describe('HolderInformationRequest — vinculação a Validation (PR 1)', () => {
  it('cria solicitação vinculada a uma Validation do mesmo tenant', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org PR1', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave PR1', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-pr1-001', true)
    const validationId = await createValidation()

    const res = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Comprovante de residência',
        items: [
          {
            itemId: 'address-proof',
            description: 'Comprovante de residência',
            required: true,
            documentType: 'proof_of_address',
          },
        ],
        validationId,
      },
      key.secret,
    )
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.validationId).toBe(validationId)
    expect(body.tenantId).toBe(tenantId)
    expect(body.holderId).toBe(holderId)
    expect(body.state).toBe('pending')
  })

  it('não cria solicitação com Validation de outro tenant', async () => {
    const outroCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')
    const outroTenantId = await createOrganization(outroCookie, 'Org Outro PR1', 'outro@exemplo.com')
    await addMember(outroCookie, outroTenantId, 'outro@exemplo.com', 'admin')

    // Holder do tenant do owner
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Owner PR1', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')
    const ownerKey = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Owner PR1', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])
    const holderId = await createHolder(ownerKey, tenantId, 'ext-ref-pr1-002', true)

    // Validation do outro tenant (criada com a sessão do outro usuário).
    const outroValidationId = await createValidation(outroCookie)

    const res = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Comprovante cruzado',
        items: [
          {
            itemId: 'address-proof',
            description: 'Comprovante de residência',
            required: true,
            documentType: 'proof_of_address',
          },
        ],
        validationId: outroValidationId,
      },
      ownerKey.secret,
    )
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('VALIDATION_NOT_FOUND')
  })

  it('não cria solicitação com Validation inexistente', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Sem Validation', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Sem Validation', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-pr1-003', true)

    const res = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Sem validation',
        items: [
          {
            itemId: 'address-proof',
            description: 'Comprovante de residência',
            required: true,
            documentType: 'proof_of_address',
          },
        ],
        validationId: '00000000-0000-4000-8000-000000000000',
      },
      key.secret,
    )
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('VALIDATION_NOT_FOUND')
  })

  it('cria solicitação sem validationId (compatibilidade)', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Sem Vínculo', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Sem Vínculo', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-pr1-004', true)

    const res = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Sem vínculo',
        items: [
          {
            itemId: 'address-proof',
            description: 'Comprovante de residência',
            required: true,
            documentType: 'proof_of_address',
          },
        ],
      },
      key.secret,
    )
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.validationId).toBeNull()
  })

  it('GET da solicitação retorna validationId', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Get PR1', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Get PR1', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-pr1-005', true)
    const validationId = await createValidation()

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Para GET',
        items: [
          {
            itemId: 'address-proof',
            description: 'Comprovante de residência',
            required: true,
            documentType: 'proof_of_address',
          },
        ],
        validationId,
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const requestId = createRes.json().id

    const getRes = await injectWithM2M(
      'GET',
      `/v1/information-requests/${requestId}?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(getRes.statusCode).toBe(200)
    expect(getRes.json().validationId).toBe(validationId)
  })
})
