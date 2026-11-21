import { createHmac, randomUUID } from 'node:crypto'
import { createDbPool, eq, runMigrations, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { sha256Of } from '@comprova/providers'
import { createLogger, createMetrics } from '@comprova/observability'
import { startTestDb, startTestRedis, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import Redis from 'ioredis'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

const PEPPER = 'test-pepper-123'

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])
const PDF_BYTES = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a])

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminSql = postgres(db.adminUrl, { max: 1 })
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

const appPool = createDbPool(db.appUrl)

/** Fake store com conteúdo inspecionável. */
const storeObjects = new Map<string, Uint8Array>()
const fakeStore = {
  put: async (key: string, data: Uint8Array) => {
    storeObjects.set(key, Uint8Array.from(data))
    return { key, uri: `memory://${key}`, sha256: sha256Of(data), bytes: data.byteLength }
  },
  delete: async (_key: string) => {
    storeObjects.delete(_key)
  },
}

const baseConfig = {
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
  TERMS_DOCUMENT_HASH: 'sha256:6c055ec85b30720af261de4e611e480509774189acbb6eeec4ef8f784250220a',
  TERMS_DOCUMENT_CONTENT: 'Conteúdo de termos de teste para comprovação de endereço.',
  WORKER_LOOPS: false,
} as const

const testLogger = createLogger({ level: 'silent' })
const testMetrics = createMetrics()

const buildTestApp = (terms: {
  TERMS_VERSION?: string
  TERMS_APPROVED?: string
  TERMS_DOCUMENT_HASH?: string
  TERMS_DOCUMENT_CONTENT?: string
}) =>
  buildApp({
    config: { ...baseConfig, ...terms },
    db: appPool.db,
    redis,
    logger: testLogger,
    metrics: testMetrics,
    objectStore: fakeStore,
  })

const app = await buildTestApp({})

/**
 * Instância com o conteúdo jurídico ainda NÃO aprovado. O aceite do Holder
 * precisa ser bloqueado sem persistir consentimento — nunca simular um aceite
 * válido quando não existe texto aprovado.
 */
const appTermsNotApproved = await buildTestApp({ TERMS_APPROVED: 'false' })

let ownerSessionCookie: string
let tenantId: string
let m2mSecret: string

const signUp = async (email: string, password: string, name: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/verifier/sign-up/email',
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
    url: '/v1/auth/verifier/sign-in/email',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  expect(res.statusCode).toBe(200)
  const setCookie = res.headers['set-cookie']
  if (!setCookie) throw new Error('No set-cookie header')
  const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie
  const match = cookieHeader.match(/verifier-auth\.session_token=([^;]+)/)
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
    Cookie: `verifier-auth.session_token=${sessionCookie}`,
    origin: 'http://verifier.localhost:5174',
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
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${secret ?? m2mSecret}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

let holderIpCounter = 0

const injectAsHolder = (
  method: string,
  url: string,
  token: string | undefined,
  extra?: { payload?: Buffer | string; headers?: Record<string, string>; ip?: string },
) => {
  holderIpCounter = (holderIpCounter + 1) % 250
  const remoteAddress = extra?.ip ?? `10.7.0.${holderIpCounter + 1}`
  const headers: Record<string, string> = { ...(extra?.headers ?? {}) }
  if (token !== undefined) headers['x-holder-token'] = token
  return app.inject({
    method,
    url,
    headers,
    remoteAddress,
    ...(extra?.payload !== undefined ? { payload: extra.payload } : {}),
  })
}

const createOrganization = async (_sessionCookie: string, name: string, email: string): Promise<string> => {
  const res = await injectWithSession('POST', '/v1/organizations', {
    name,
    email,
    termsVersion: '1.0.0',
  })
  expect(res.statusCode).toBe(201)
  return res.json().tenantId
}

const addMember = async (
  _sessionCookie: string,
  tenantId: string,
  email: string,
  role: 'member' | 'admin' | 'owner',
) => {
  return injectWithSession('POST', `/v1/organizations/${tenantId}/members`, { email, role })
}

const createM2mApiKey = async (_sessionCookie: string, tenantId: string, name: string, scopes: string[]) => {
  const res = await injectWithSession('POST', `/v1/m2m/api-keys?tenantId=${tenantId}`, {
    name,
    scopes,
    keyType: 'm2m',
  })
  expect(res.statusCode).toBe(201)
  return res.json().secret as string
}

const createHolder = async (externalReference: string): Promise<string> => {
  const documento = '12345678901'
  const tenantSecret = createHmac('sha256', PEPPER).update(tenantId).digest('hex')
  const documentHash = createHmac('sha256', tenantSecret).update(documento).digest('hex')
  const res = await injectWithM2M('POST', `/v1/holders?tenantId=${tenantId}`, {
    externalReference,
    name: 'Titular Teste',
    documentHash,
    documentType: 'CPF',
  })
  expect(res.statusCode).toBe(201)
  return res.json().holderId
}

const createRequest = async (
  externalReference: string,
  items?: readonly {
    readonly itemId: string
    readonly description: string
    readonly required: boolean
    readonly documentType?: string
  }[],
  expiresAt?: string,
) => {
  const holderId = await createHolder(externalReference)
  const res = await injectWithM2M(
    'POST',
    `/v1/holders/${holderId}/information-requests?tenantId=${tenantId}`,
    {
      type: 'documento_complementar',
      purpose: 'Comprovante de residência',
      items: items ?? [
        {
          itemId: 'address-proof',
          description: 'Comprovante de residência',
          required: true,
          documentType: 'proof_of_address',
        },
      ],
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
  )
  expect(res.statusCode).toBe(201)
  return { holderId, requestId: res.json().id }
}

const issueTokenOk = async (requestId: string) => {
  const res = await injectWithM2M(
    'POST',
    `/v1/information-requests/${requestId}/access-tokens?tenantId=${tenantId}`,
  )
  expect(res.statusCode).toBe(201)
  return res.json() as { tokenId: string; token: string; expiresAt: string; createdAt: string }
}

const multipartPayload = (
  data: Uint8Array,
  filename = 'comprovante.png',
  contentType = 'image/png',
): { readonly payload: Buffer; readonly headers: Record<string, string> } => {
  const boundary = `----comprova-${randomUUID()}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, Buffer.from(data), tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

const countEvents = async (requestId: string, eventType: string): Promise<number> => {
  const rows = await adminSql`
    SELECT count(*)::int AS n FROM holder_information_request_event
    WHERE holder_information_request_id = ${requestId} AND event_type = ${eventType}`
  return rows[0]!.n
}

const consentRowsOf = async (requestId: string) =>
  adminSql`
    SELECT id, terms_version, state, accepted_at, created_at
    FROM holder_consent
    WHERE holder_information_request_id = ${requestId}
    ORDER BY created_at`

const expireRequest = async (requestId: string): Promise<void> => {
  await withTenant(appPool.db, tenantId, async (tx) => {
    await tx
      .update(t.holderInformationRequest)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(t.holderInformationRequest.id, requestId))
  })
}

beforeAll(async () => {
  await signUp('owner-consent@exemplo.com', 'SenhaForte123!', 'Dono Consent')
  ownerSessionCookie = await loginAndGetCookie('owner-consent@exemplo.com', 'SenhaForte123!')
  tenantId = await createOrganization(ownerSessionCookie, 'Org Holder Consent', 'owner-consent@exemplo.com')
  await addMember(ownerSessionCookie, tenantId, 'owner-consent@exemplo.com', 'admin')
  m2mSecret = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Holder Consent', [
    'holders:read',
    'holders:write',
    'verify:m2m',
  ])
})

afterAll(async () => {
  await app.close()
  await appTermsNotApproved.close()
  redis.disconnect()
  await adminSql.end()
  await appPool.end()
  await db.stop()
  await testRedis.stop()
})

describe('F4.1 — consentimento do Holder', () => {
  it('aceite explícito registra consentimento com versão dos termos e relógio do banco', async () => {
    const { requestId } = await createRequest('consent-ok')
    const issued = await issueTokenOk(requestId)

    const res = await injectAsHolder('POST', '/v1/holder-access/consent', issued.token, {
      payload: JSON.stringify({ termsVersion: '1.0.0' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().granted).toBe(true)
    expect(res.json().termsVersion).toBe('1.0.0')
    expect(res.json().acceptedAt).not.toBeNull()

    const rows = await consentRowsOf(requestId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.terms_version).toBe('1.0.0')
    expect(rows[0]!.state).toBe('granted')
    expect(rows[0]!.accepted_at).not.toBeNull()

    // Evento de auditoria persistido
    expect(await countEvents(requestId, 'holder_consent_granted')).toBe(1)
  })

  it('consentimento resposta contém acceptedAt do relógio do banco', async () => {
    const { requestId } = await createRequest('consent-clock')
    const issued = await issueTokenOk(requestId)

    const before = Date.now()
    const res = await injectAsHolder('POST', '/v1/holder-access/consent', issued.token, {
      payload: JSON.stringify({ termsVersion: '1.0.0' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    const acceptedAt = new Date(res.json().acceptedAt!).getTime()
    expect(acceptedAt).toBeGreaterThanOrEqual(before)
    expect(acceptedAt).toBeLessThanOrEqual(Date.now())
  })

  it('sem corpo ou termsVersion vazio → 400', async () => {
    const { requestId } = await createRequest('consent-empty')
    const issued = await issueTokenOk(requestId)

    const empty = await injectAsHolder('POST', '/v1/holder-access/consent', issued.token, {
      payload: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    })
    expect(empty.statusCode).toBe(400)

    const missing = await injectAsHolder('POST', '/v1/holder-access/consent', issued.token, {
      payload: JSON.stringify({ termsVersion: '' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(missing.statusCode).toBe(400)
  })

  it('versão divergente da vigente → 409 e nenhum consentimento persistido', async () => {
    const { requestId } = await createRequest('consent-version-mismatch')
    const issued = await issueTokenOk(requestId)

    const res = await injectAsHolder('POST', '/v1/holder-access/consent', issued.token, {
      payload: JSON.stringify({ termsVersion: '2.0.0' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('HOLDER_TERMS_VERSION_MISMATCH')

    // Nada é persistido: nem consentimento, nem evento de auditoria.
    expect(await consentRowsOf(requestId)).toHaveLength(0)
    expect(await countEvents(requestId, 'holder_consent_granted')).toBe(0)

    // Upload continua bloqueado: o Holder não pode contornar o aceite.
    const part = multipartPayload(PNG_BYTES)
    const upload = await injectAsHolder(
      'POST',
      '/v1/holder-access/items/address-proof/documents',
      issued.token,
      { payload: part.payload, headers: part.headers },
    )
    expect(upload.statusCode).toBe(403)
  })

  it('versão arbitrária nunca é aceita como se fosse a vigente', async () => {
    const { requestId } = await createRequest('consent-version-arbitrary')
    const issued = await issueTokenOk(requestId)

    for (const termsVersion of ['0.0.1', 'v1.0', '1.0.0-beta', 'qualquer-coisa']) {
      const res = await injectAsHolder('POST', '/v1/holder-access/consent', issued.token, {
        payload: JSON.stringify({ termsVersion }),
        headers: { 'content-type': 'application/json' },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe('HOLDER_TERMS_VERSION_MISMATCH')
    }

    expect(await consentRowsOf(requestId)).toHaveLength(0)
  })

  it('conteúdo jurídico não aprovado → 409 e nenhum consentimento persistido', async () => {
    const { requestId } = await createRequest('consent-not-approved')
    const issued = await issueTokenOk(requestId)

    holderIpCounter = (holderIpCounter + 1) % 250
    const res = await appTermsNotApproved.inject({
      method: 'POST',
      url: '/v1/holder-access/consent',
      headers: {
        'x-holder-token': issued.token,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ termsVersion: '1.0.0' }),
      remoteAddress: `10.9.0.${holderIpCounter + 1}`,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('HOLDER_TERMS_NOT_APPROVED')

    // A visão pública informa que o conteúdo não está aprovado, sem expor
    // detalhes internos; o frontend bloqueia o aceite com essa informação.
    holderIpCounter = (holderIpCounter + 1) % 250
    const view = await appTermsNotApproved.inject({
      method: 'GET',
      url: '/v1/holder-access',
      headers: { 'x-holder-token': issued.token },
      remoteAddress: `10.9.0.${holderIpCounter + 1}`,
    })
    expect(view.statusCode).toBe(200)
    expect(view.json().terms).toEqual({
      version: '1.0.0',
      approved: false,
      documentHash: 'sha256:6c055ec85b30720af261de4e611e480509774189acbb6eeec4ef8f784250220a',
      content: 'Conteúdo de termos de teste para comprovação de endereço.',
      hashValid: true,
    })

    // Sem texto aprovado, o servidor não inventa consentimento.
    expect(await consentRowsOf(requestId)).toHaveLength(0)
    expect(await countEvents(requestId, 'holder_consent_granted')).toBe(0)
  })

  it('sem conteúdo dos termos cadastrado → 409 e nenhum consentimento persistido', async () => {
    const { requestId } = await createRequest('consent-no-content')
    const issued = await issueTokenOk(requestId)

    // App sem conteúdo dos termos cadastrado (TERMS_DOCUMENT_CONTENT ausente)
    holderIpCounter = (holderIpCounter + 1) % 250
    const appNoContent = await buildTestApp({ TERMS_DOCUMENT_CONTENT: undefined })
    const res = await appNoContent.inject({
      method: 'POST',
      url: '/v1/holder-access/consent',
      headers: {
        'x-holder-token': issued.token,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ termsVersion: '1.0.0' }),
      remoteAddress: `10.9.0.${holderIpCounter + 1}`,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('HOLDER_TERMS_NOT_APPROVED')

    // Nada é persistido sem conteúdo aprovado.
    expect(await consentRowsOf(requestId)).toHaveLength(0)
    expect(await countEvents(requestId, 'holder_consent_granted')).toBe(0)
  })

  it('hash divergente do conteúdo → 409 e nenhum consentimento persistido', async () => {
    const { requestId } = await createRequest('consent-hash-divergent')
    const issued = await issueTokenOk(requestId)

    // App com hash que não confere com o conteúdo
    holderIpCounter = (holderIpCounter + 1) % 250
    const appHashDivergent = await buildTestApp({
      TERMS_DOCUMENT_HASH: 'sha256:hash_divergente_que_nao_confere',
    })
    const res = await appHashDivergent.inject({
      method: 'POST',
      url: '/v1/holder-access/consent',
      headers: {
        'x-holder-token': issued.token,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ termsVersion: '1.0.0' }),
      remoteAddress: `10.9.0.${holderIpCounter + 1}`,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('HOLDER_TERMS_HASH_INVALID')

    // Nada é persistido com hash divergente.
    expect(await consentRowsOf(requestId)).toHaveLength(0)
    expect(await countEvents(requestId, 'holder_consent_granted')).toBe(0)
  })

  it('token ausente → 401 (não exige Better Auth)', async () => {
    await createRequest('consent-no-token')
    const res = await injectAsHolder('POST', '/v1/holder-access/consent', undefined, {
      payload: JSON.stringify({ termsVersion: '1.0.0' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('HOLDER_ACCESS_UNAUTHORIZED')
  })

  it('token revogado → 401', async () => {
    const { requestId } = await createRequest('consent-revoked')
    const issued = await issueTokenOk(requestId)
    await injectWithM2M(
      'DELETE',
      `/v1/information-requests/${requestId}/access-tokens/${issued.tokenId}?tenantId=${tenantId}`,
    )

    const res = await injectAsHolder('POST', '/v1/holder-access/consent', issued.token, {
      payload: JSON.stringify({ termsVersion: '1.0.0' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('solicitação expirada: não é possível emitir token (consentimento bloqueado)', async () => {
    const { requestId } = await createRequest(
      'consent-expired',
      undefined,
      new Date(Date.now() + 60_000).toISOString(),
    )
    await expireRequest(requestId)

    // Emissão de token falha para request expirado → consentimento impossível.
    const res = await injectWithM2M(
      'POST',
      `/v1/information-requests/${requestId}/access-tokens?tenantId=${tenantId}`,
    )
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('HOLDER_INFORMATION_REQUEST_EXPIRED')
  })

  it('solicitação cancelada: token revogado → 401', async () => {
    const { requestId } = await createRequest('consent-cancelled')
    const issued = await issueTokenOk(requestId)
    await injectWithM2M('POST', `/v1/information-requests/${requestId}/cancel?tenantId=${tenantId}`, {
      toState: 'cancelled',
      reason: 'Cancelado',
    })

    const res = await injectAsHolder('POST', '/v1/holder-access/consent', issued.token, {
      payload: JSON.stringify({ termsVersion: '1.0.0' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('HOLDER_ACCESS_UNAUTHORIZED')
  })

  it('repetição do aceite é idempotente (mesmo consentimento, nenhum duplicado)', async () => {
    const { requestId } = await createRequest('consent-idem')
    const issued = await issueTokenOk(requestId)

    const first = await injectAsHolder('POST', '/v1/holder-access/consent', issued.token, {
      payload: JSON.stringify({ termsVersion: '1.0.0' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().granted).toBe(true)

    const second = await injectAsHolder('POST', '/v1/holder-access/consent', issued.token, {
      payload: JSON.stringify({ termsVersion: '1.0.0' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().granted).toBe(true)

    const rows = await consentRowsOf(requestId)
    expect(rows).toHaveLength(1)
    expect(await countEvents(requestId, 'holder_consent_granted')).toBe(1)
  })

  it('upload sem consentimento → 403', async () => {
    const { requestId } = await createRequest('consent-upload-block')
    const issued = await issueTokenOk(requestId)

    const part = multipartPayload(PNG_BYTES)
    const res = await injectAsHolder(
      'POST',
      '/v1/holder-access/items/address-proof/documents',
      issued.token,
      { payload: part.payload, headers: part.headers },
    )
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('HOLDER_CONSENT_REQUIRED')
  })

  it('upload após consentimento → 200', async () => {
    const { requestId } = await createRequest('consent-upload-ok')
    const issued = await issueTokenOk(requestId)

    const consent = await injectAsHolder('POST', '/v1/holder-access/consent', issued.token, {
      payload: JSON.stringify({ termsVersion: '1.0.0' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(consent.statusCode).toBe(200)

    const part = multipartPayload(PNG_BYTES)
    const upload = await injectAsHolder(
      'POST',
      '/v1/holder-access/items/address-proof/documents',
      issued.token,
      { payload: part.payload, headers: part.headers },
    )
    expect(upload.statusCode).toBe(200)

    // O documento aparece na visão do Holder
    const view = await injectAsHolder('GET', '/v1/holder-access', issued.token)
    expect(view.statusCode).toBe(200)
    expect(view.json().items[0].documents).toHaveLength(1)
  })

  it('view inclui status e consentimento', async () => {
    const { requestId } = await createRequest('consent-view')
    const issued = await issueTokenOk(requestId)

    // Sem consentimento: aguardando_consentimento
    let view = await injectAsHolder('GET', '/v1/holder-access', issued.token)
    expect(view.statusCode).toBe(200)
    expect(view.json().state).toBe('pending')
    expect(view.json().status).toBe('aguardando_consentimento')
    expect(view.json().consent.granted).toBe(false)
    expect(view.json().consent.termsVersion).toBeNull()
    expect(view.json().consent.acceptedAt).toBeNull()

    // A versão vigente dos termos é do servidor, não escolhida pelo cliente.
    expect(view.json().terms).toEqual({
      version: '1.0.0',
      approved: true,
      documentHash: 'sha256:6c055ec85b30720af261de4e611e480509774189acbb6eeec4ef8f784250220a',
      content: 'Conteúdo de termos de teste para comprovação de endereço.',
      hashValid: true,
    })

    // Após consentimento: aguardando_documentos
    await injectAsHolder('POST', '/v1/holder-access/consent', issued.token, {
      payload: JSON.stringify({ termsVersion: '1.0.0' }),
      headers: { 'content-type': 'application/json' },
    })
    view = await injectAsHolder('GET', '/v1/holder-access', issued.token)
    expect(view.json().status).toBe('aguardando_documentos')
    expect(view.json().consent.granted).toBe(true)
    expect(view.json().consent.termsVersion).toBe('1.0.0')
    expect(view.json().consent.acceptedAt).not.toBeNull()

    // Após upload: documento_recebido
    const part = multipartPayload(PNG_BYTES)
    await injectAsHolder('POST', '/v1/holder-access/items/address-proof/documents', issued.token, {
      payload: part.payload,
      headers: part.headers,
    })
    view = await injectAsHolder('GET', '/v1/holder-access', issued.token)
    expect(view.json().status).toBe('documento_recebido')
  })

  it('não retorna token nem hash na view', async () => {
    const { requestId } = await createRequest('consent-no-token-exposure')
    const issued = await issueTokenOk(requestId)

    const view = await injectAsHolder('GET', '/v1/holder-access', issued.token)
    expect(view.statusCode).toBe(200)
    const body = JSON.stringify(view.json())
    expect(body).not.toContain(issued.token)
    expect(body).not.toContain(tenantId)
    expect(view.json()).not.toHaveProperty('holderId')
  })

  it('respostas usam Cache-Control: no-store', async () => {
    const { requestId } = await createRequest('consent-cache')
    const issued = await issueTokenOk(requestId)

    const consent = await injectAsHolder('POST', '/v1/holder-access/consent', issued.token, {
      payload: JSON.stringify({ termsVersion: '1.0.0' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(consent.statusCode).toBe(200)
    expect(consent.headers['cache-control']).toBe('no-store')

    const view = await injectAsHolder('GET', '/v1/holder-access', issued.token)
    expect(view.statusCode).toBe(200)
    expect(view.headers['cache-control']).toBe('no-store')

    const unauthorized = await injectAsHolder('POST', '/v1/holder-access/consent', undefined, {
      payload: JSON.stringify({ termsVersion: '1.0.0' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(unauthorized.statusCode).toBe(401)
    expect(unauthorized.headers['cache-control']).toBe('no-store')
  })

  it('concorrência: dois aceites concorrentes geram um único consentimento', async () => {
    const { requestId } = await createRequest('consent-concurrent')
    const issued = await issueTokenOk(requestId)

    const results = await Promise.all([
      injectAsHolder('POST', '/v1/holder-access/consent', issued.token, {
        payload: JSON.stringify({ termsVersion: '1.0.0' }),
        headers: { 'content-type': 'application/json' },
      }),
      injectAsHolder('POST', '/v1/holder-access/consent', issued.token, {
        payload: JSON.stringify({ termsVersion: '1.0.0' }),
        headers: { 'content-type': 'application/json' },
      }),
    ])
    expect(results.every((r) => r.statusCode === 200)).toBe(true)
    expect(results.every((r) => r.json().granted === true)).toBe(true)

    const rows = await consentRowsOf(requestId)
    expect(rows).toHaveLength(1)
    expect(await countEvents(requestId, 'holder_consent_granted')).toBe(1)
  })

  it('consentimento de outra solicitação não é acessível (isolamento)', async () => {
    const { requestId: requestA } = await createRequest('consent-iso-a')
    const { requestId: requestB } = await createRequest('consent-iso-b')
    const issuedA = await issueTokenOk(requestA)
    const issuedB = await issueTokenOk(requestB)

    // Consentimento da solicitação A
    await injectAsHolder('POST', '/v1/holder-access/consent', issuedA.token, {
      payload: JSON.stringify({ termsVersion: '1.0.0' }),
      headers: { 'content-type': 'application/json' },
    })

    // Token da solicitação B não vê consentimento da A
    const viewB = await injectAsHolder('GET', '/v1/holder-access', issuedB.token)
    expect(viewB.json().consent.granted).toBe(false)

    // Upload na B sem consentimento próprio → 403
    const part = multipartPayload(PNG_BYTES)
    const uploadB = await injectAsHolder(
      'POST',
      '/v1/holder-access/items/address-proof/documents',
      issuedB.token,
      { payload: part.payload, headers: part.headers },
    )
    expect(uploadB.statusCode).toBe(403)
  })

  it('token de outra solicitação não aceita consentimento cruzado', async () => {
    const { requestId: requestA } = await createRequest('consent-cross-a')
    const { requestId: requestB } = await createRequest('consent-cross-b')
    const issuedB = await issueTokenOk(requestB)

    const res = await injectAsHolder('POST', '/v1/holder-access/consent', issuedB.token, {
      payload: JSON.stringify({ termsVersion: '1.0.0' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)

    // O consentimento pertence à solicitação B, não à A
    const rowsA = await consentRowsOf(requestA)
    expect(rowsA).toHaveLength(0)
    const rowsB = await consentRowsOf(requestB)
    expect(rowsB).toHaveLength(1)
  })

  it('PDF com magic bytes incompatível após consentimento → 422 (validações preservadas)', async () => {
    const { requestId } = await createRequest('consent-pdf-invalid')
    const issued = await issueTokenOk(requestId)
    await injectAsHolder('POST', '/v1/holder-access/consent', issued.token, {
      payload: JSON.stringify({ termsVersion: '1.0.0' }),
      headers: { 'content-type': 'application/json' },
    })

    const part = multipartPayload(PDF_BYTES, 'doc.png', 'image/png')
    const res = await injectAsHolder(
      'POST',
      '/v1/holder-access/items/address-proof/documents',
      issued.token,
      { payload: part.payload, headers: part.headers },
    )
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('EVIDENCE_CONTENT_MISMATCH')
  })
})
