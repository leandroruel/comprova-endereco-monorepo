import { createHmac } from 'node:crypto'
import { and, eq, withTenant, createDbPool, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
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

describe('HolderInformationRequest Integration', () => {
  it('deve criar uma solicitação de informações válida', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Info Req', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Info Req', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-info-001', true)

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

    const res = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Comprovante de residência atualizado',
        items: [
          {
            itemId: 'address-proof',
            description: 'Comprovante de residência atualizado',
            required: true,
            documentType: 'proof_of_address',
          },
        ],
        expiresAt,
      },
      key.secret,
    )
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.id).toBeDefined()
    expect(body.tenantId).toBe(tenantId)
    expect(body.holderId).toBe(holderId)
    expect(body.type).toBe('documento_complementar')
    expect(body.purpose).toBe('Comprovante de residência atualizado')
    expect(body.state).toBe('pending')
    expect(body.items).toHaveLength(1)
    expect(body.items[0].itemId).toBe('address-proof')
    expect(body.expiresAt).toBe(expiresAt)
  })

  it('não deve criar solicitação para Holder inexistente', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Holder Inexistente',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Holder Inexistente', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const res = await injectWithM2M(
      'POST',
      `/v1/holders/00000000-0000-4000-8000-000000000000/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Qualquer coisa',
        items: [
          {
            itemId: 'address-proof',
            description: 'Comprovante de residência',
            required: true,
          },
        ],
      },
      key.secret,
    )
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('HOLDER_NOT_FOUND')
  })

  it('não deve criar solicitação para Holder de outro tenant', async () => {
    const outroCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')
    const outroTenantId = await createOrganization(outroCookie, 'Org Outro Tenant Info', 'outro@exemplo.com')
    await addMember(outroCookie, outroTenantId, 'outro@exemplo.com', 'admin')

    const outroKey = await createM2mApiKey(outroCookie, outroTenantId, 'Chave Outro Tenant Info', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(outroKey, outroTenantId, 'ext-ref-outro-info', true)

    // Chave da org principal tenta criar solicitação para holder do outro tenant
    const ownerTenantId = await createOrganization(
      ownerSessionCookie,
      'Org Principal Info',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, ownerTenantId, 'owner@exemplo.com', 'admin')
    const ownerKey = await createM2mApiKey(ownerSessionCookie, ownerTenantId, 'Chave Principal Info', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const res = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${ownerTenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Tentativa cruzada',
        items: [
          {
            itemId: 'address-proof',
            description: 'Comprovante',
            required: true,
          },
        ],
      },
      ownerKey.secret,
    )
    // Holder não pertence ao tenant informado → 404
    expect(res.statusCode).toBe(404)
  })

  it('não deve criar solicitação sem scope holders:write', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Sem Escopo Info', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    // Chave com escrita para criar o holder
    const keyWrite = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Com Escrita Info', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])
    const holderId = await createHolder(keyWrite, tenantId, 'ext-ref-sem-escopo-info', true)

    // Chave sem holders:write
    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Sem Escopo Info', [
      'holders:read',
      'verify:m2m',
    ])

    const res = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Sem escrita',
        items: [
          {
            itemId: 'address-proof',
            description: 'Comprovante',
            required: true,
          },
        ],
      },
      key.secret,
    )
    expect(res.statusCode).toBe(403)
  })

  it('não deve aceitar itens com itemId duplicado', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Item Duplicado', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Item Duplicado', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-item-duplicado', true)

    const res = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Itens duplicados',
        items: [
          {
            itemId: 'address-proof',
            description: 'Primeiro',
            required: true,
          },
          {
            itemId: 'address-proof',
            description: 'Segundo',
            required: true,
          },
        ],
      },
      key.secret,
    )
    expect(res.statusCode).toBe(400)
  })

  it('não deve aceitar prazo expirado', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Prazo Expirado', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Prazo Expirado', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-prazo-expirado', true)

    const res = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Prazo expirado',
        items: [
          {
            itemId: 'address-proof',
            description: 'Comprovante',
            required: true,
          },
        ],
        expiresAt: '2020-01-01T00:00:00Z',
      },
      key.secret,
    )
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_EXPIRES_AT')
  })

  it('deve consultar solicitação por ID', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Consulta Info', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Consulta Info', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-consulta-info', true)

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Para consulta',
        items: [
          {
            itemId: 'address-proof',
            description: 'Comprovante',
            required: true,
          },
        ],
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const requestId = createRes.json().id

    const res = await injectWithM2M(
      'GET',
      `/v1/information-requests/${requestId}?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.id).toBe(requestId)
    expect(body.holderId).toBe(holderId)
    expect(body.state).toBe('pending')
  })

  it('não deve consultar solicitação inexistente', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Consulta Inexistente',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Consulta Inexistente', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const res = await injectWithM2M(
      'GET',
      `/v1/information-requests/00000000-0000-4000-8000-000000000000?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(res.statusCode).toBe(404)
  })

  it('deve listar solicitações por Holder', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Listagem Por Holder',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Listagem Por Holder', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-listagem-holder', true)

    // Cria 2 solicitações
    for (let i = 0; i < 2; i++) {
      const res = await injectWithM2M(
        'POST',
        `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
        {
          type: 'documento_complementar',
          purpose: `Solicitação ${i}`,
          items: [
            {
              itemId: `item-${i}`,
              description: `Descrição ${i}`,
              required: true,
            },
          ],
        },
        key.secret,
      )
      expect(res.statusCode).toBe(201)
    }

    const res = await injectWithM2M(
      'GET',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.requests)).toBe(true)
    expect(body.requests.length).toBe(2)
    expect(body.total).toBe(2)
  })

  it('deve listar solicitações do tenant com filtros', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Listagem Tenant', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Listagem Tenant', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-listagem-tenant', true)

    // Cria uma solicitação
    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Para listagem',
        items: [
          {
            itemId: 'item-1',
            description: 'Desc 1',
            required: true,
          },
        ],
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)

    // Lista com filtro de estado
    const res = await injectWithM2M(
      'GET',
      `/v1/information-requests?tenantId=${tenantId}&state=pending`,
      undefined,
      key.secret,
    )
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.requests.length).toBeGreaterThanOrEqual(1)
    expect(body.requests.every((r: { state: string }) => r.state === 'pending')).toBe(true)
  })

  it('deve cancelar uma solicitação válida', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Cancelamento', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Cancelamento', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-cancelamento', true)

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Para cancelar',
        items: [
          {
            itemId: 'address-proof',
            description: 'Comprovante',
            required: true,
          },
        ],
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const requestId = createRes.json().id

    const cancelRes = await injectWithM2M(
      'POST',
      `/v1/information-requests/${requestId}/cancel?tenantId=${tenantId}`,
      { toState: 'cancelled', reason: 'Não é mais necessário' },
      key.secret,
    )
    expect(cancelRes.statusCode).toBe(200)
    expect(cancelRes.json().state).toBe('cancelled')
    expect(cancelRes.json().cancelledAt).toBeDefined()
  })

  it('não deve cancelar solicitação já cancelada', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Cancelamento Duplo',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Cancelamento Duplo', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-cancelamento-duplo', true)

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Para cancelar duplo',
        items: [
          {
            itemId: 'address-proof',
            description: 'Comprovante',
            required: true,
          },
        ],
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const requestId = createRes.json().id

    // Primeiro cancelamento
    await injectWithM2M(
      'POST',
      `/v1/information-requests/${requestId}/cancel?tenantId=${tenantId}`,
      { toState: 'cancelled', reason: 'Primeiro' },
      key.secret,
    )

    // Segundo cancelamento deve falhar (estado terminal)
    const res = await injectWithM2M(
      'POST',
      `/v1/information-requests/${requestId}/cancel?tenantId=${tenantId}`,
      { toState: 'cancelled', reason: 'Segundo' },
      key.secret,
    )
    expect(res.statusCode).toBe(409)
  })

  it('deve persistir `expired` em vez de `cancelled` quando prazo já venceu', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Expiração Cancel Info',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Expiração Cancel Info', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-expiracao-cancel-info', true)

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Prazo vencido antes do cancelamento',
        items: [
          {
            itemId: 'address-proof',
            description: 'Comprovante',
            required: true,
          },
        ],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const requestId = createRes.json().id

    // Vence o prazo diretamente no banco
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx
        .update(t.holderInformationRequest)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(t.holderInformationRequest.id, requestId))
    })

    // Tenta cancelar: deve persistir `expired`, não `cancelled`
    const cancelRes = await injectWithM2M(
      'POST',
      `/v1/information-requests/${requestId}/cancel?tenantId=${tenantId}`,
      { toState: 'cancelled', reason: 'Após expiração' },
      key.secret,
    )
    expect(cancelRes.statusCode).toBe(200)
    expect(cancelRes.json().state).toBe('expired')
    expect(cancelRes.json().cancelledAt).toBeNull()

    // Verifica evento de expiração (não de cancelamento)
    const events = await withTenant(appPool.db, tenantId, async (tx) => {
      return tx
        .select({ event_type: t.holderInformationRequestEvent.eventType })
        .from(t.holderInformationRequestEvent)
        .where(
          and(
            eq(t.holderInformationRequestEvent.holderInformationRequestId, requestId),
            eq(t.holderInformationRequestEvent.tenantId, tenantId),
          ),
        )
    })
    expect(events.some((e) => e.event_type === 'expired')).toBe(true)
    expect(events.some((e) => e.event_type === 'cancelled')).toBe(false)
  })

  it('deve listar solicitações do tenant filtrando por holderId', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Filtro Holder Info',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Filtro Holder Info', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderIdA = await createHolder(key, tenantId, 'ext-ref-filtro-a', true)
    const holderIdB = await createHolder(key, tenantId, 'ext-ref-filtro-b', true)

    // Cria solicitações para cada holder
    const createResA = await injectWithM2M(
      'POST',
      `/v1/holders/${holderIdA}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Holder A',
        items: [{ itemId: 'item-a', description: 'Desc A', required: true }],
      },
      key.secret,
    )
    expect(createResA.statusCode).toBe(201)
    const createResB = await injectWithM2M(
      'POST',
      `/v1/holders/${holderIdB}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Holder B',
        items: [{ itemId: 'item-b', description: 'Desc B', required: true }],
      },
      key.secret,
    )
    expect(createResB.statusCode).toBe(201)

    // Lista filtrando por holderIdA
    const res = await injectWithM2M(
      'GET',
      `/v1/information-requests?tenantId=${tenantId}&holderId=${holderIdA}`,
      undefined,
      key.secret,
    )
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.requests.length).toBe(1)
    expect(body.requests[0].holderId).toBe(holderIdA)
  })

  it('deve rejeitar filtro de estado inválido na listagem', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Estado Invalido Info',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Estado Invalido Info', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const res = await injectWithM2M(
      'GET',
      `/v1/information-requests?tenantId=${tenantId}&state=estado_inexistente`,
      undefined,
      key.secret,
    )
    expect(res.statusCode).toBe(400)
  })

  it('deve aplicar expiração quando prazo vence antes de operação de leitura', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Expiração Info', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Expiração Info', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-expiracao-info', true)

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Para expirar',
        items: [
          {
            itemId: 'address-proof',
            description: 'Comprovante',
            required: true,
          },
        ],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const requestId = createRes.json().id

    // Avança o prazo diretamente no banco para simular expiração
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx
        .update(t.holderInformationRequest)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(t.holderInformationRequest.id, requestId))
    })

    // Consulta deve retornar estado `expired` (expiração aplicada lazy)
    const getRes = await injectWithM2M(
      'GET',
      `/v1/information-requests/${requestId}?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(getRes.statusCode).toBe(200)
    expect(getRes.json().state).toBe('expired')

    // Verifica evento de expiração persistido
    const events = await withTenant(appPool.db, tenantId, async (tx) => {
      return tx
        .select({ event_type: t.holderInformationRequestEvent.eventType })
        .from(t.holderInformationRequestEvent)
        .where(
          and(
            eq(t.holderInformationRequestEvent.holderInformationRequestId, requestId),
            eq(t.holderInformationRequestEvent.tenantId, tenantId),
          ),
        )
    })
    expect(events.some((e) => e.event_type === 'expired')).toBe(true)
  })

  it('deve aplicar expiração durante a listagem antes de consultar por ID', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Expiração Listagem Info',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Expiração Listagem Info', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-expiracao-listagem', true)

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Para expirar na listagem',
        items: [
          {
            itemId: 'address-proof',
            description: 'Comprovante',
            required: true,
          },
        ],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const requestId = createRes.json().id

    // Vence o prazo diretamente no banco
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx
        .update(t.holderInformationRequest)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(t.holderInformationRequest.id, requestId))
    })

    // Lista filtrando por estado pending: não deve conter a solicitação vencida
    const pendingRes = await injectWithM2M(
      'GET',
      `/v1/information-requests?tenantId=${tenantId}&state=pending`,
      undefined,
      key.secret,
    )
    expect(pendingRes.statusCode).toBe(200)
    expect(pendingRes.json().requests.some((r: { id: string }) => r.id === requestId)).toBe(false)

    // Lista filtrando por estado expired: deve conter a solicitação vencida
    const expiredRes = await injectWithM2M(
      'GET',
      `/v1/information-requests?tenantId=${tenantId}&state=expired`,
      undefined,
      key.secret,
    )
    expect(expiredRes.statusCode).toBe(200)
    expect(expiredRes.json().requests.some((r: { id: string }) => r.id === requestId)).toBe(true)

    // Verifica evento de expiração persistido
    const events = await withTenant(appPool.db, tenantId, async (tx) => {
      return tx
        .select({ event_type: t.holderInformationRequestEvent.eventType })
        .from(t.holderInformationRequestEvent)
        .where(
          and(
            eq(t.holderInformationRequestEvent.holderInformationRequestId, requestId),
            eq(t.holderInformationRequestEvent.tenantId, tenantId),
          ),
        )
    })
    expect(events.some((e) => e.event_type === 'expired')).toBe(true)

    // Consulta por ID também retorna estado expirado
    const getRes = await injectWithM2M(
      'GET',
      `/v1/information-requests/${requestId}?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(getRes.statusCode).toBe(200)
    expect(getRes.json().state).toBe('expired')
  })

  it('deve aplicar expiração em lote apenas para solicitações vencidas', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Expiração Lote Info',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Expiração Lote Info', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-lote-a', true)

    // Cria três solicitações pendentes: uma vencida e duas dentro do prazo.
    const vencidaRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Vencida',
        items: [{ itemId: 'item-vencida', description: 'Vencida', required: true }],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      key.secret,
    )
    expect(vencidaRes.statusCode).toBe(201)
    const vencidaId = vencidaRes.json().id

    const validaRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Válida',
        items: [{ itemId: 'item-valida', description: 'Válida', required: true }],
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
      key.secret,
    )
    expect(validaRes.statusCode).toBe(201)
    const validaId = validaRes.json().id

    const outraRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Outra válida',
        items: [{ itemId: 'item-outra', description: 'Outra', required: true }],
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
      key.secret,
    )
    expect(outraRes.statusCode).toBe(201)
    const outraId = outraRes.json().id

    // Vence o prazo da primeira diretamente no banco
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx
        .update(t.holderInformationRequest)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(t.holderInformationRequest.id, vencidaId))
    })

    // Lista para disparar a expiração em lote
    const listRes = await injectWithM2M(
      'GET',
      `/v1/information-requests?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(listRes.statusCode).toBe(200)
    const body = listRes.json()

    // A vencida deve estar como expired
    const vencida = body.requests.find((r: { id: string }) => r.id === vencidaId)
    expect(vencida).toBeDefined()
    expect(vencida.state).toBe('expired')

    // As válidas devem continuar como pending
    const valida = body.requests.find((r: { id: string }) => r.id === validaId)
    expect(valida).toBeDefined()
    expect(valida.state).toBe('pending')

    const outra = body.requests.find((r: { id: string }) => r.id === outraId)
    expect(outra).toBeDefined()
    expect(outra.state).toBe('pending')

    // Verifica eventos: apenas um evento expired para a vencida, com o estado
    // de origem real (pending) — e não o estado pós-atualização (expired).
    const events = await withTenant(appPool.db, tenantId, async (tx) => {
      return tx
        .select({
          eventType: t.holderInformationRequestEvent.eventType,
          holderInformationRequestId: t.holderInformationRequestEvent.holderInformationRequestId,
          fromState: t.holderInformationRequestEvent.fromState,
        })
        .from(t.holderInformationRequestEvent)
        .where(
          and(
            eq(t.holderInformationRequestEvent.eventType, 'expired'),
            eq(t.holderInformationRequestEvent.tenantId, tenantId),
          ),
        )
    })
    expect(events.length).toBe(1)
    expect(events[0]!.holderInformationRequestId).toBe(vencidaId)
    expect(events[0]!.fromState).toBe('pending')
  })

  it('deve aplicar expiração em lote sem criar eventos quando nada venceu', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Expiração Lote Vazio Info',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Expiração Lote Vazio Info', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-lote-vazio', true)

    // Cria solicitação dentro do prazo
    await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Sem expiração',
        items: [{ itemId: 'item-sem-expiração', description: 'Sem expiração', required: true }],
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
      key.secret,
    )

    // Lista para disparar a expiração em lote (não deve criar eventos)
    const listRes = await injectWithM2M(
      'GET',
      `/v1/information-requests?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(listRes.statusCode).toBe(200)
    const body = listRes.json()
    expect(body.requests.length).toBe(1)
    expect(body.requests[0].state).toBe('pending')

    // Verifica que nenhum evento de expiração foi criado
    const events = await withTenant(appPool.db, tenantId, async (tx) => {
      return tx
        .select({ eventType: t.holderInformationRequestEvent.eventType })
        .from(t.holderInformationRequestEvent)
        .where(
          and(
            eq(t.holderInformationRequestEvent.eventType, 'expired'),
            eq(t.holderInformationRequestEvent.tenantId, tenantId),
          ),
        )
    })
    expect(events.length).toBe(0)
  })

  it('deve cancelar antes do prazo com resultado cancelled', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Cancel Antes Prazo Info',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Cancel Antes Prazo Info', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-cancel-antes-prazo', true)

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Cancelar antes do prazo',
        items: [{ itemId: 'item-a', description: 'Item A', required: true }],
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const requestId = createRes.json().id

    const cancelRes = await injectWithM2M(
      'POST',
      `/v1/information-requests/${requestId}/cancel?tenantId=${tenantId}`,
      { toState: 'cancelled', reason: 'Antes do prazo' },
      key.secret,
    )
    expect(cancelRes.statusCode).toBe(200)
    expect(cancelRes.json().state).toBe('cancelled')

    // Verifica evento de cancelamento
    const events = await withTenant(appPool.db, tenantId, async (tx) => {
      return tx
        .select({
          eventType: t.holderInformationRequestEvent.eventType,
          fromState: t.holderInformationRequestEvent.fromState,
          toState: t.holderInformationRequestEvent.toState,
        })
        .from(t.holderInformationRequestEvent)
        .where(
          and(
            eq(t.holderInformationRequestEvent.holderInformationRequestId, requestId),
            eq(t.holderInformationRequestEvent.tenantId, tenantId),
          ),
        )
    })
    const cancelEvent = events.find((e) => e.eventType === 'cancelled')
    expect(cancelEvent).toBeDefined()
    expect(cancelEvent?.fromState).toBe('pending')
    expect(cancelEvent?.toState).toBe('cancelled')
  })

  it('deve expirar em vez de cancelar quando prazo venceu entre leitura e atualização', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Corrida Expiração Cancel Info',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Corrida Expiração Cancel Info', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-corrida-exp-cancel', true)

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Corrida expiração x cancelamento',
        items: [{ itemId: 'item-a', description: 'Item A', required: true }],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const requestId = createRes.json().id

    // Vence o prazo diretamente no banco (simulando passagem do tempo entre
    // leitura e atualização da requisição de cancelamento)
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx
        .update(t.holderInformationRequest)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(t.holderInformationRequest.id, requestId))
    })

    // Tenta cancelar: deve persistir expired, não cancelled
    const cancelRes = await injectWithM2M(
      'POST',
      `/v1/information-requests/${requestId}/cancel?tenantId=${tenantId}`,
      { toState: 'cancelled', reason: 'Após expiração' },
      key.secret,
    )
    expect(cancelRes.statusCode).toBe(200)
    expect(cancelRes.json().state).toBe('expired')
    expect(cancelRes.json().cancelledAt).toBeNull()

    // Verifica evento de expiração
    const events = await withTenant(appPool.db, tenantId, async (tx) => {
      return tx
        .select({
          eventType: t.holderInformationRequestEvent.eventType,
          fromState: t.holderInformationRequestEvent.fromState,
          toState: t.holderInformationRequestEvent.toState,
        })
        .from(t.holderInformationRequestEvent)
        .where(
          and(
            eq(t.holderInformationRequestEvent.holderInformationRequestId, requestId),
            eq(t.holderInformationRequestEvent.tenantId, tenantId),
          ),
        )
    })
    const expiredEvent = events.find((e) => e.eventType === 'expired')
    expect(expiredEvent).toBeDefined()
    expect(expiredEvent?.fromState).toBe('pending')
    expect(expiredEvent?.toState).toBe('expired')
    expect(events.some((e) => e.eventType === 'cancelled')).toBe(false)
  })

  it('não deve duplicar eventos de expiração em execução repetida do lote', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Expiração Lote Sem Duplicar Info',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(
      ownerSessionCookie,
      tenantId,
      'Chave Expiração Lote Sem Duplicar Info',
      ['holders:read', 'holders:write', 'verify:m2m'],
    )

    const holderId = await createHolder(key, tenantId, 'ext-ref-lote-sem-duplicar', true)

    // Cria solicitação vencida - captura o requestId da resposta
    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Para expirar',
        items: [{ itemId: 'item-a', description: 'Item A', required: true }],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const requestId = createRes.json().id

    // Vence o prazo diretamente no banco
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx
        .update(t.holderInformationRequest)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(t.holderInformationRequest.id, requestId))
    })

    // Primeira execução do lote
    const listRes1 = await injectWithM2M(
      'GET',
      `/v1/information-requests?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(listRes1.statusCode).toBe(200)

    // Segunda execução do lote - não deve criar novo evento
    const listRes2 = await injectWithM2M(
      'GET',
      `/v1/information-requests?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(listRes2.statusCode).toBe(200)

    // Verifica que existe exatamente um evento de expiração
    const events = await withTenant(appPool.db, tenantId, async (tx) => {
      return tx
        .select({ eventType: t.holderInformationRequestEvent.eventType })
        .from(t.holderInformationRequestEvent)
        .where(
          and(
            eq(t.holderInformationRequestEvent.eventType, 'expired'),
            eq(t.holderInformationRequestEvent.tenantId, tenantId),
          ),
        )
    })
    expect(events.length).toBe(1)
  })

  it('deve gerar exatamente um evento de expiração em cancelamento concorrente', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Concorrência Expiração Cancel Info',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(
      ownerSessionCookie,
      tenantId,
      'Chave Concorrência Expiração Cancel Info',
      ['holders:read', 'holders:write', 'verify:m2m'],
    )

    const holderId = await createHolder(key, tenantId, 'ext-ref-concorrencia-exp-cancel', true)

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Concorrência expiração x cancelamento',
        items: [{ itemId: 'item-a', description: 'Item A', required: true }],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const requestId = createRes.json().id

    // Vence o prazo diretamente no banco
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx
        .update(t.holderInformationRequest)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(t.holderInformationRequest.id, requestId))
    })

    // Duas requisições concorrentes de cancelamento
    const results = await Promise.all([
      injectWithM2M(
        'POST',
        `/v1/information-requests/${requestId}/cancel?tenantId=${tenantId}`,
        { toState: 'cancelled', reason: 'Cancelamento 1' },
        key.secret,
      ),
      injectWithM2M(
        'POST',
        `/v1/information-requests/${requestId}/cancel?tenantId=${tenantId}`,
        { toState: 'cancelled', reason: 'Cancelamento 2' },
        key.secret,
      ),
    ])

    // Nenhuma deve retornar estado cancelled
    const states = results.map((r) => r.json().state)
    expect(states.every((s) => s !== 'cancelled')).toBe(true)

    // Verifica que existe exatamente um evento de expiração
    const events = await withTenant(appPool.db, tenantId, async (tx) => {
      return tx
        .select({ eventType: t.holderInformationRequestEvent.eventType })
        .from(t.holderInformationRequestEvent)
        .where(
          and(
            eq(t.holderInformationRequestEvent.holderInformationRequestId, requestId),
            eq(t.holderInformationRequestEvent.tenantId, tenantId),
          ),
        )
    })
    const expiredEvents = events.filter((e) => e.eventType === 'expired')
    expect(expiredEvents.length).toBe(1)
  })

  it('não deve cancelar solicitação inexistente', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Cancelamento Inexistente',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Cancelamento Inexistente', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const res = await injectWithM2M(
      'POST',
      `/v1/information-requests/00000000-0000-4000-8000-000000000000/cancel?tenantId=${tenantId}`,
      { toState: 'cancelled' },
      key.secret,
    )
    expect(res.statusCode).toBe(404)
  })

  it('deve aplicar isolamento multi-tenant na listagem', async () => {
    const outroCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')
    const outroTenantId = await createOrganization(outroCookie, 'Org Isolada Info', 'outro@exemplo.com')
    await addMember(outroCookie, outroTenantId, 'outro@exemplo.com', 'admin')
    const outroKey = await createM2mApiKey(outroCookie, outroTenantId, 'Chave Isolada Info', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const outroHolderId = await createHolder(outroKey, outroTenantId, 'ext-ref-isolado-info', true)

    // Cria solicitação no tenant do outro
    await injectWithM2M(
      'POST',
      `/v1/holders/${outroHolderId}/information-requests?tenantId=${outroTenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Solicitação isolada',
        items: [
          {
            itemId: 'address-proof',
            description: 'Comprovante',
            required: true,
          },
        ],
      },
      outroKey.secret,
    )

    // Chave da org principal lista solicitações do próprio tenant (não vê a do outro)
    const ownerTenantId = await createOrganization(
      ownerSessionCookie,
      'Org Principal Isolada Info',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, ownerTenantId, 'owner@exemplo.com', 'admin')
    const ownerKey = await createM2mApiKey(
      ownerSessionCookie,
      ownerTenantId,
      'Chave Principal Isolada Info',
      ['holders:read', 'holders:write', 'verify:m2m'],
    )

    const res = await injectWithM2M(
      'GET',
      `/v1/information-requests?tenantId=${ownerTenantId}`,
      undefined,
      ownerKey.secret,
    )
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.requests.every((r: { tenantId: string }) => r.tenantId === ownerTenantId)).toBe(true)
  })

  it('deve gerar evento de auditoria na criação e cancelamento', async () => {
    const tenantId = await createOrganization(ownerSessionCookie, 'Org Auditoria Info', 'owner@exemplo.com')
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Auditoria Info', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-auditoria-info', true)

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Para auditoria',
        items: [
          {
            itemId: 'address-proof',
            description: 'Comprovante',
            required: true,
          },
        ],
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const requestId = createRes.json().id

    // Verifica evento de criação persistido na tabela de eventos
    const createdEvents = await withTenant(appPool.db, tenantId, async (tx) => {
      return tx
        .select({
          event_type: t.holderInformationRequestEvent.eventType,
          from_state: t.holderInformationRequestEvent.fromState,
          to_state: t.holderInformationRequestEvent.toState,
          actor: t.holderInformationRequestEvent.actor,
        })
        .from(t.holderInformationRequestEvent)
        .where(
          and(
            eq(t.holderInformationRequestEvent.holderInformationRequestId, requestId),
            eq(t.holderInformationRequestEvent.tenantId, tenantId),
          ),
        )
    })
    expect(createdEvents.length).toBeGreaterThanOrEqual(1)
    const createdEvent = createdEvents.find((e) => e.event_type === 'created')
    expect(createdEvent).toBeDefined()
    expect(createdEvent?.from_state).toBeNull()
    expect(createdEvent?.to_state).toBe('pending')

    // Verifica cancelamento via API
    const cancelRes = await injectWithM2M(
      'POST',
      `/v1/information-requests/${requestId}/cancel?tenantId=${tenantId}`,
      { toState: 'cancelled', reason: 'Auditoria cancelamento' },
      key.secret,
    )
    expect(cancelRes.statusCode).toBe(200)

    // Verifica evento de cancelamento persistido
    const cancelledEvents = await withTenant(appPool.db, tenantId, async (tx) => {
      return tx
        .select({
          event_type: t.holderInformationRequestEvent.eventType,
          from_state: t.holderInformationRequestEvent.fromState,
          to_state: t.holderInformationRequestEvent.toState,
          actor: t.holderInformationRequestEvent.actor,
        })
        .from(t.holderInformationRequestEvent)
        .where(
          and(
            eq(t.holderInformationRequestEvent.holderInformationRequestId, requestId),
            eq(t.holderInformationRequestEvent.tenantId, tenantId),
          ),
        )
    })
    expect(cancelledEvents.length).toBeGreaterThanOrEqual(2)
    const cancelEvent = cancelledEvents.find((e) => e.event_type === 'cancelled')
    expect(cancelEvent).toBeDefined()
    expect(cancelEvent?.from_state).toBe('pending')
    expect(cancelEvent?.to_state).toBe('cancelled')

    // Verifica estado final da solicitação
    const getRes = await injectWithM2M(
      'GET',
      `/v1/information-requests/${requestId}?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(getRes.statusCode).toBe(200)
    expect(getRes.json().state).toBe('cancelled')
    expect(getRes.json().cancelledAt).toBeDefined()
  })

  it('não deve cancelar solicitação de outro tenant (OR não escapa do tenant)', async () => {
    const outroCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')
    const outroTenantId = await createOrganization(
      outroCookie,
      'Org Outro Tenant Cancel Info',
      'outro@exemplo.com',
    )
    await addMember(outroCookie, outroTenantId, 'outro@exemplo.com', 'admin')
    const outroKey = await createM2mApiKey(outroCookie, outroTenantId, 'Chave Outro Tenant Cancel Info', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const outroHolderId = await createHolder(outroKey, outroTenantId, 'ext-ref-outro-cancel', true)

    // Outro cria solicitação no próprio tenant
    const outroCreateRes = await injectWithM2M(
      'POST',
      `/v1/holders/${outroHolderId}/information-requests?tenantId=${outroTenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Solicitação outro tenant',
        items: [{ itemId: 'item-a', description: 'Item A', required: true }],
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
      outroKey.secret,
    )
    expect(outroCreateRes.statusCode).toBe(201)
    const outroRequestId = outroCreateRes.json().id

    // Outro cancela sua própria solicitação
    const cancelRes = await injectWithM2M(
      'POST',
      `/v1/information-requests/${outroRequestId}/cancel?tenantId=${outroTenantId}`,
      { toState: 'cancelled', reason: 'Cancelamento pelo titular' },
      outroKey.secret,
    )
    expect(cancelRes.statusCode).toBe(200)

    // Verifica que a solicitação foi cancelada
    const outroCheck = await injectWithM2M(
      'GET',
      `/v1/information-requests/${outroRequestId}?tenantId=${outroTenantId}`,
      undefined,
      outroKey.secret,
    )
    expect(outroCheck.statusCode).toBe(200)
    expect(outroCheck.json().state).toBe('cancelled')
  })

  it('não deve expirar solicitação com prazo futuro', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Prazo Futuro Info',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Prazo Futuro Info', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-prazo-futuro', true)

    // Cria solicitação com prazo bem no futuro
    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Prazo futuro',
        items: [{ itemId: 'item-a', description: 'Item A', required: true }],
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const requestId = createRes.json().id

    // Lista - não deve expirar nada (prazo no futuro)
    const listRes = await injectWithM2M(
      'GET',
      `/v1/information-requests?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(listRes.statusCode).toBe(200)
    const body = listRes.json()
    expect(body.requests.length).toBe(1)
    expect(body.requests[0].state).toBe('pending')

    // Tenta cancelar - deve funcionar normalmente (prazo não vencido)
    const cancelRes = await injectWithM2M(
      'POST',
      `/v1/information-requests/${requestId}/cancel?tenantId=${tenantId}`,
      { toState: 'cancelled', reason: 'Prazo futuro ainda' },
      key.secret,
    )
    expect(cancelRes.statusCode).toBe(200)
    expect(cancelRes.json().state).toBe('cancelled')

    // Verifica evento de cancelamento (não de expiração)
    const events = await withTenant(appPool.db, tenantId, async (tx) => {
      return tx
        .select({ eventType: t.holderInformationRequestEvent.eventType })
        .from(t.holderInformationRequestEvent)
        .where(
          and(
            eq(t.holderInformationRequestEvent.holderInformationRequestId, requestId),
            eq(t.holderInformationRequestEvent.tenantId, tenantId),
          ),
        )
    })
    const cancelEvents = events.filter((e) => e.eventType === 'cancelled')
    const expiredEvents = events.filter((e) => e.eventType === 'expired')
    expect(cancelEvents.length).toBe(1)
    expect(expiredEvents.length).toBe(0)
  })

  it('não deve travar ao consultar por ID solicitação pendente com prazo futuro', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Prazo Futuro Consulta Info',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Prazo Futuro Consulta Info', [
      'holders:read',
      'holders:write',
      'verify:m2m',
    ])

    const holderId = await createHolder(key, tenantId, 'ext-ref-prazo-futuro-consulta', true)

    // Cria solicitação com prazo no futuro
    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Prazo futuro na consulta',
        items: [{ itemId: 'item-a', description: 'Item A', required: true }],
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const requestId = createRes.json().id

    // Consulta por ID: o UPDATE condicional não deve afetar linhas (prazo
    // futuro) e a reavaliação não pode entrar em loop; deve responder com o
    // estado vigente.
    const res = await injectWithM2M(
      'GET',
      `/v1/information-requests/${requestId}?tenantId=${tenantId}`,
      undefined,
      key.secret,
    )
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.id).toBe(requestId)
    expect(body.state).toBe('pending')

    // Nenhum evento de expiração deve ser criado
    const expiredEvents = await withTenant(appPool.db, tenantId, async (tx) => {
      return tx
        .select({ id: t.holderInformationRequestEvent.id })
        .from(t.holderInformationRequestEvent)
        .where(
          and(
            eq(t.holderInformationRequestEvent.holderInformationRequestId, requestId),
            eq(t.holderInformationRequestEvent.tenantId, tenantId),
            eq(t.holderInformationRequestEvent.eventType, 'expired'),
          ),
        )
    })
    expect(expiredEvents.length).toBe(0)
  })

  it('deve gerar exatamente um evento de expiração em cancelamento concorrente quando prazo vencido', async () => {
    const tenantId = await createOrganization(
      ownerSessionCookie,
      'Org Concorrência Expiração Cancel Info',
      'owner@exemplo.com',
    )
    await addMember(ownerSessionCookie, tenantId, 'owner@exemplo.com', 'admin')

    const key = await createM2mApiKey(
      ownerSessionCookie,
      tenantId,
      'Chave Concorrência Expiração Cancel Info',
      ['holders:read', 'holders:write', 'verify:m2m'],
    )

    const holderId = await createHolder(key, tenantId, 'ext-ref-concorrencia-exp-cancel', true)

    const createRes = await injectWithM2M(
      'POST',
      `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
      {
        type: 'documento_complementar',
        purpose: 'Concorrência expiração x cancelamento',
        items: [{ itemId: 'item-a', description: 'Item A', required: true }],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      key.secret,
    )
    expect(createRes.statusCode).toBe(201)
    const requestId = createRes.json().id

    // Vence o prazo diretamente no banco
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx
        .update(t.holderInformationRequest)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(t.holderInformationRequest.id, requestId))
    })

    // Duas requisições concorrentes de cancelamento
    const results = await Promise.all([
      injectWithM2M(
        'POST',
        `/v1/information-requests/${requestId}/cancel?tenantId=${tenantId}`,
        { toState: 'cancelled', reason: 'Cancelamento 1' },
        key.secret,
      ),
      injectWithM2M(
        'POST',
        `/v1/information-requests/${requestId}/cancel?tenantId=${tenantId}`,
        { toState: 'cancelled', reason: 'Cancelamento 2' },
        key.secret,
      ),
    ])

    // Nenhuma deve retornar estado cancelled
    const states = results.map((r) => r.json().state)
    expect(states.every((s) => s !== 'cancelled')).toBe(true)

    // Verifica que existe exatamente um evento de expiração
    const events = await withTenant(appPool.db, tenantId, async (tx) => {
      return tx
        .select({ eventType: t.holderInformationRequestEvent.eventType })
        .from(t.holderInformationRequestEvent)
        .where(
          and(
            eq(t.holderInformationRequestEvent.holderInformationRequestId, requestId),
            eq(t.holderInformationRequestEvent.tenantId, tenantId),
          ),
        )
    })
    const expiredEvents = events.filter((e) => e.eventType === 'expired')
    expect(expiredEvents.length).toBe(1)
  })
})
