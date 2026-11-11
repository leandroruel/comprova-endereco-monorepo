import { createHmac, randomUUID } from 'node:crypto'
import { createDbPool, eq, runMigrations, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { sha256Of } from '@comprova/providers'
import { createLogger, createMetrics } from '@comprova/observability'
import { startTestDb, startTestRedis, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import type { ObjectStore, StoredObject } from '@comprova/providers'
import Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { HOLDER_RATE_LIMIT_LAYERS } from '../src/plugins/holder-rate-limit.js'

const PEPPER = 'test-pepper-123'

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])

const storeObjects = new Map<string, Uint8Array>()
const fakeStore: ObjectStore = {
  put: async (key, data): Promise<StoredObject> => {
    storeObjects.set(key, Uint8Array.from(data))
    return { key, uri: `memory://${key}`, sha256: sha256Of(data), bytes: data.byteLength }
  },
  delete: async (key) => {
    storeObjects.delete(key)
  },
}

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

const appConfig = {
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
} as const

const appPool = createDbPool(db.appUrl)
const app = await buildApp({
  config: appConfig,
  db: appPool.db,
  redis,
  logger: createLogger({ level: 'silent' }),
  metrics: createMetrics(),
  objectStore: fakeStore,
})

const deadRedis = new Redis('redis://127.0.0.1:59999/', {
  // Evita log de erro não tratado durante o teste.
  retryStrategy: () => null,
  maxRetriesPerRequest: 0,
  enableOfflineQueue: true,
  lazyConnect: false,
})
deadRedis.on('error', () => undefined)
const failClosedApp = await buildApp({
  config: appConfig,
  db: appPool.db,
  redis: deadRedis,
  logger: createLogger({ level: 'silent' }),
  metrics: createMetrics(),
  objectStore: fakeStore,
})

let ownerSessionCookie: string
let tenantId: string
let m2mSecret: string

const FIXED_IP = '10.9.9.9'

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
  return (
    match?.[1] ??
    (() => {
      throw new Error('Session token not found')
    })()
  )
}

const injectWithSession = async (method: string, url: string, body?: unknown) => {
  const headers: Record<string, string> = { Cookie: `legacy-auth.session_token=${ownerSessionCookie}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.inject({ method, url, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
}

const injectWithM2M = async (method: string, url: string, body?: unknown) => {
  return app.inject({
    method,
    url,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${m2mSecret}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

const injectAsHolder = (
  method: string,
  url: string,
  token: string | undefined,
  extra?: {
    payload?: Buffer
    headers?: Record<string, string>
    target?: typeof app
    remoteAddress?: string
  },
) => {
  const target = extra?.target ?? app
  const headers: Record<string, string> = { ...(extra?.headers ?? {}) }
  if (token !== undefined) headers['x-holder-token'] = token
  return target.inject({
    method,
    url,
    headers,
    remoteAddress: extra?.remoteAddress ?? FIXED_IP,
    ...(extra?.payload ? { payload: extra.payload } : {}),
  })
}

const multipartPayload = (
  data: Uint8Array,
): { readonly payload: Buffer; readonly headers: Record<string, string> } => {
  const boundary = `----comprova-${randomUUID()}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="doc.png"\r\nContent-Type: image/png\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, Buffer.from(data), tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

beforeAll(async () => {
  await signUp('owner-rl@exemplo.com', 'SenhaForte123!', 'Dono Rate Limit')
  ownerSessionCookie = await loginAndGetCookie('owner-rl@exemplo.com', 'SenhaForte123!')
  const org = await injectWithSession('POST', '/v1/organizations', {
    name: 'Org Rate Limit',
    email: 'owner-rl@exemplo.com',
    termsVersion: '1.0.0',
  })
  expect(org.statusCode).toBe(201)
  tenantId = org.json().tenantId
  await injectWithSession('POST', `/v1/organizations/${tenantId}/members`, {
    email: 'owner-rl@exemplo.com',
    role: 'admin',
  })
  const key = await injectWithSession('POST', `/v1/m2m/api-keys?tenantId=${tenantId}`, {
    name: 'Chave Rate Limit',
    scopes: ['holders:read', 'holders:write', 'verify:m2m'],
    keyType: 'm2m',
  })
  expect(key.statusCode).toBe(201)
  m2mSecret = key.json().secret
})

afterAll(async () => {
  await app.close()
  await failClosedApp.close()
  redis.disconnect()
  deadRedis.disconnect()
  await adminPool.end()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

const createRequestWithToken = async () => {
  const documento = '12345678901'
  const tenantSecret = createHmac('sha256', PEPPER).update(tenantId).digest('hex')
  const documentHash = createHmac('sha256', tenantSecret).update(documento).digest('hex')
  const holderRes = await injectWithM2M('POST', `/v1/holders?tenantId=${tenantId}`, {
    externalReference: `rl-${randomUUID()}`,
    name: 'Titular RL',
    documentHash,
    documentType: 'CPF',
  })
  expect(holderRes.statusCode).toBe(201)
  const holderId = holderRes.json().holderId

  const requestRes = await injectWithM2M(
    'POST',
    `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
    {
      type: 'documento_complementar',
      purpose: 'Comprovante',
      items: [
        {
          itemId: 'address-proof',
          description: 'Comprovante',
          required: true,
          documentType: 'proof_of_address',
        },
      ],
    },
  )
  expect(requestRes.statusCode).toBe(201)
  const requestId = requestRes.json().id

  const tokenRes = await injectWithM2M(
    'POST',
    `/v1/information-requests/${requestId}/access-tokens?tenantId=${tenantId}`,
  )
  expect(tokenRes.statusCode).toBe(201)
  return { requestId, token: tokenRes.json().token as string, tokenId: tokenRes.json().tokenId as string }
}

describe('F4.2 — rate limiting do acesso do Holder', () => {
  it('usa exatamente os limites aprovados para F4.2', () => {
    expect(HOLDER_RATE_LIMIT_LAYERS).toEqual({
      ip: { ratePerSecond: 1, burst: 30 },
      token: { ratePerSecond: 1, burst: 30 },
      upload: { ratePerSecond: 10 / 60, burst: 3 },
      invalid: { ratePerSecond: 10 / 60, burst: 10 },
    })
  })

  it('limite de tentativas inválidas por IP: 10 × 401, depois 429', async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await injectAsHolder('GET', '/v1/holder-access', undefined)
      expect(res.statusCode).toBe(401)
      expect(res.headers['cache-control']).toBe('no-store')
    }
    const exceeded = await injectAsHolder('GET', '/v1/holder-access', undefined)
    expect(exceeded.statusCode).toBe(429)
    expect(exceeded.json().code).toBe('RATE_LIMITED')
    expect(exceeded.headers['retry-after']).toBeDefined()
    // Respostas de erro do limitador também não podem ser cacheadas.
    expect(exceeded.headers['cache-control']).toBe('no-store')

    // O bucket de tentativas inválidas é por IP: outro IP não é afetado.
    const otherIp = await injectAsHolder('GET', '/v1/holder-access', undefined, {
      remoteAddress: '10.9.9.10',
    })
    expect(otherIp.statusCode).toBe(401)
    expect(otherIp.json().code).toBe('HOLDER_ACCESS_UNAUTHORIZED')
  })

  it('limite de uploads por token: 3 OK (burst), depois 429', async () => {
    const { requestId, token } = await createRequestWithToken()

    for (let i = 0; i < 3; i += 1) {
      const part = multipartPayload(PNG_BYTES)
      const res = await injectAsHolder('POST', '/v1/holder-access/items/address-proof/documents', token, {
        payload: part.payload,
        headers: part.headers,
      })
      expect(res.statusCode).toBe(200)
    }

    const part = multipartPayload(PNG_BYTES)
    const exceeded = await injectAsHolder('POST', '/v1/holder-access/items/address-proof/documents', token, {
      payload: part.payload,
      headers: part.headers,
    })
    expect(exceeded.statusCode).toBe(429)
    expect(exceeded.json().code).toBe('RATE_LIMITED')

    // Leitura continua funcionando (outra camada) e o estado não foi corrompido.
    const view = await injectAsHolder('GET', '/v1/holder-access', token)
    expect(view.statusCode).toBe(200)
    expect(view.json().items[0].documents).toHaveLength(3)

    // Limpeza do estado de emissão para não afetar outros testes.
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx
        .update(t.holderAccessToken)
        .set({ revokedAt: new Date() })
        .where(eq(t.holderAccessToken.holderInformationRequestId, requestId))
    })
  })

  it('isolamento por token: esgotar uploads de um token não bloqueia outro', async () => {
    const first = await createRequestWithToken()
    const second = await createRequestWithToken()

    for (let i = 0; i < 3; i += 1) {
      const part = multipartPayload(PNG_BYTES)
      const res = await injectAsHolder(
        'POST',
        '/v1/holder-access/items/address-proof/documents',
        first.token,
        { payload: part.payload, headers: part.headers },
      )
      expect(res.statusCode).toBe(200)
    }

    const blockedPart = multipartPayload(PNG_BYTES)
    const blocked = await injectAsHolder(
      'POST',
      '/v1/holder-access/items/address-proof/documents',
      first.token,
      { payload: blockedPart.payload, headers: blockedPart.headers },
    )
    expect(blocked.statusCode).toBe(429)

    // O segundo token tem bucket próprio e continua aceitando uploads.
    const otherPart = multipartPayload(PNG_BYTES)
    const other = await injectAsHolder(
      'POST',
      '/v1/holder-access/items/address-proof/documents',
      second.token,
      { payload: otherPart.payload, headers: otherPart.headers },
    )
    expect(other.statusCode).toBe(200)

    // Limpeza do estado de emissão para não afetar outros testes.
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx
        .update(t.holderAccessToken)
        .set({ revokedAt: new Date() })
        .where(eq(t.holderAccessToken.holderInformationRequestId, first.requestId))
      await tx
        .update(t.holderAccessToken)
        .set({ revokedAt: new Date() })
        .where(eq(t.holderAccessToken.holderInformationRequestId, second.requestId))
    })
  })

  it('recupera capacidade conforme a taxa do bucket de upload', async () => {
    const { requestId, token } = await createRequestWithToken()
    // IP dedicado: não consome o bucket de IP usado pelos demais testes.
    const remoteAddress = '10.9.9.12'
    const url = '/v1/holder-access/items/address-proof/documents'

    for (let i = 0; i < 3; i += 1) {
      const part = multipartPayload(PNG_BYTES)
      const res = await injectAsHolder('POST', url, token, {
        payload: part.payload,
        headers: part.headers,
        remoteAddress,
      })
      expect(res.statusCode).toBe(200)
    }

    const blockedPart = multipartPayload(PNG_BYTES)
    const blocked = await injectAsHolder('POST', url, token, {
      payload: blockedPart.payload,
      headers: blockedPart.headers,
      remoteAddress,
    })
    expect(blocked.statusCode).toBe(429)

    // Upload é 10/min: 1 token a cada 6 s. Polling até o bucket refilar,
    // com timeout limitado para evitar espera indefinida em caso de CI lento.
    const recoveredPart = multipartPayload(PNG_BYTES)
    const deadline = Date.now() + 30_000
    let recovered: Awaited<ReturnType<typeof injectAsHolder>>
    let recoveredStatus = 0
    do {
      recovered = await injectAsHolder('POST', url, token, {
        payload: recoveredPart.payload,
        headers: recoveredPart.headers,
        remoteAddress,
      })
      recoveredStatus = recovered.statusCode
      if (recoveredStatus === 200) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    } while (Date.now() < deadline)
    expect(recoveredStatus).toBe(200)

    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx
        .update(t.holderAccessToken)
        .set({ revokedAt: new Date() })
        .where(eq(t.holderAccessToken.holderInformationRequestId, requestId))
    })
  })

  it('Redis indisponível → 503 fail-closed (nunca permite)', async () => {
    const { token } = await createRequestWithToken()

    const started = Date.now()
    const res = await injectAsHolder('GET', '/v1/holder-access', token, { target: failClosedApp })
    const elapsed = Date.now() - started

    expect(res.statusCode).toBe(503)
    expect(res.json().code).toBe('RATE_LIMIT_UNAVAILABLE')
    expect(res.headers['cache-control']).toBe('no-store')
    // O timeout do limitador responde rápido (500 ms + folga), não trava a rota.
    expect(elapsed).toBeLessThan(5_000)
  })
})
