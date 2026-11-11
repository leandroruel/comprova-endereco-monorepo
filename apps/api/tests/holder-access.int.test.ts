import { createHmac, randomUUID } from 'node:crypto'
import { createDbPool, eq, runMigrations, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { sha256Of } from '@comprova/providers'
import { createLogger, createMetrics } from '@comprova/observability'
import { startTestDb, startTestRedis, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import type { ObjectStore, StoredObject } from '@comprova/providers'
import Redis from 'ioredis'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

const PEPPER = 'test-pepper-123'

function computeDocumentHash(documento: string, tenantId: string): string {
  const tenantSecret = createHmac('sha256', PEPPER).update(tenantId).digest('hex')
  return createHmac('sha256', tenantSecret).update(documento).digest('hex')
}

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])
const PDF_BYTES = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a])

/** Fake store com conteúdo inspecionável: verifica remoção física real. */
const storeObjects = new Map<string, Uint8Array>()
/** Quantas remoções físicas ainda devem falhar (simula indisponibilidade do storage). */
let failingDeletesRemaining = 0
/** Quantas vezes cada chave teve remoção física tentada. */
const deleteAttempts = new Map<string, number>()
const fakeStore: ObjectStore = {
  put: async (key, data): Promise<StoredObject> => {
    storeObjects.set(key, Uint8Array.from(data))
    return { key, uri: `memory://${key}`, sha256: sha256Of(data), bytes: data.byteLength }
  },
  delete: async (key) => {
    deleteAttempts.set(key, (deleteAttempts.get(key) ?? 0) + 1)
    if (failingDeletesRemaining > 0) {
      failingDeletesRemaining -= 1
      throw new Error('object storage unavailable')
    }
    storeObjects.delete(key)
  },
}

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
/** Cliente raw (bypassa RLS) para as verificações de auditoria. */
const adminSql = postgres(db.adminUrl, { max: 1 })
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
  objectStore: fakeStore,
})

let ownerSessionCookie: string
let tenantId: string
let m2mSecret: string

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
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${secret ?? m2mSecret}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

/** Cada requisição do Holder usa um IP distinto: isola os buckets de rate limit. */
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

const createOrganization = async (sessionCookie: string, name: string, email: string): Promise<string> => {
  const res = await injectWithSession('POST', '/v1/organizations', {
    name,
    email,
    termsVersion: '1.0.0',
  })
  expect(res.statusCode).toBe(201)
  return res.json().tenantId
}

const addMember = async (
  sessionCookie: string,
  tenantId: string,
  email: string,
  role: 'member' | 'admin' | 'owner',
) => {
  return injectWithSession('POST', `/v1/organizations/${tenantId}/members`, { email, role })
}

const createM2mApiKey = async (sessionCookie: string, tenantId: string, name: string, scopes: string[]) => {
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
  const documentHash = computeDocumentHash(documento, tenantId)
  const res = await injectWithM2M('POST', `/v1/holders?tenantId=${tenantId}`, {
    externalReference,
    name: 'Titular Teste',
    documentHash,
    documentType: 'CPF',
  })
  expect(res.statusCode).toBe(201)
  return res.json().holderId
}

interface RequestFixture {
  readonly holderId: string
  readonly requestId: string
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
): Promise<RequestFixture> => {
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

const issueToken = async (requestId: string) => {
  const res = await injectWithM2M(
    'POST',
    `/v1/information-requests/${requestId}/access-tokens?tenantId=${tenantId}`,
  )
  return res
}

const issueTokenOk = async (requestId: string) => {
  const res = await issueToken(requestId)
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

const eventsOf = async (requestId: string) =>
  adminSql`
    SELECT event_type, from_state, to_state, actor, details
    FROM holder_information_request_event
    WHERE holder_information_request_id = ${requestId}
    ORDER BY created_at`

const countEvents = async (requestId: string, eventType: string): Promise<number> => {
  const rows = await adminSql`
    SELECT count(*)::int AS n FROM holder_information_request_event
    WHERE holder_information_request_id = ${requestId} AND event_type = ${eventType}`
  return rows[0]!.n
}

const tokenRowsOf = async (requestId: string) =>
  adminSql`
    SELECT token_id, token_prefix, token_hash, expires_at, created_at, revoked_at, first_accessed_at
    FROM holder_access_token
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

const uploadDocumentOk = async (token: string, itemId: string, requestId?: string) => {
  const part = multipartPayload(PNG_BYTES)
  const res = await injectAsHolder('POST', `/v1/holder-access/items/${itemId}/documents`, token, {
    payload: part.payload,
    headers: part.headers,
  })
  expect(res.statusCode).toBe(200)
  if (requestId === undefined) return undefined

  const rows = await adminSql`
    SELECT document_id, storage_key, content_type, size_bytes, sha256, original_filename, upload_state, deleted_at
    FROM holder_information_request_document
    WHERE holder_information_request_id = ${requestId} AND deleted_at IS NULL`
  expect(rows).toHaveLength(1)
  const document = rows[0]!
  expect(document.upload_state).toBe('stored')
  expect(document.content_type).toBe('image/png')
  expect(document.size_bytes).toBe(String(PNG_BYTES.byteLength))
  expect(Buffer.from(document.sha256 as Buffer).equals(sha256Of(PNG_BYTES))).toBe(true)
  expect(document.original_filename).toBe('comprovante.png')
  expect(document.storage_key).toMatch(new RegExp(`^tenants/${tenantId}/holder-requests/${requestId}/`))
  expect(storeObjects.has(document.storage_key as string)).toBe(true)
  const documentId = document.document_id
  if (typeof documentId !== 'string') throw new Error('document_id ausente')
  return documentId
}

beforeAll(async () => {
  await signUp('owner-access@exemplo.com', 'SenhaForte123!', 'Dono Access')
  ownerSessionCookie = await loginAndGetCookie('owner-access@exemplo.com', 'SenhaForte123!')
  tenantId = await createOrganization(ownerSessionCookie, 'Org Holder Access', 'owner-access@exemplo.com')
  await addMember(ownerSessionCookie, tenantId, 'owner-access@exemplo.com', 'admin')
  m2mSecret = await createM2mApiKey(ownerSessionCookie, tenantId, 'Chave Holder Access', [
    'holders:read',
    'holders:write',
    'verify:m2m',
  ])
})

afterAll(async () => {
  await app.close()
  redis.disconnect()
  await adminSql.end()
  await adminPool.end()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

describe('F4.2 — emissão de tokens (Verifier)', () => {
  it('emite token no formato esperado com prefixo + HMAC persistidos e evento', async () => {
    const { requestId } = await createRequest('acc-emit-001')
    const issued = await issueTokenOk(requestId)

    expect(issued.token).toMatch(/^hlt_[A-Za-z0-9_-]{43}$/)
    expect(issued.tokenId).toBeDefined()
    expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000)

    const tokens = await tokenRowsOf(requestId)
    expect(tokens).toHaveLength(1)
    const row = tokens[0]!
    expect(row.token_id).toBe(issued.tokenId)
    expect(row.token_prefix).toBe(issued.token.slice(0, 12))
    expect(row.token_hash).not.toBeNull()
    expect(Buffer.from(row.token_hash).toString('hex')).not.toContain(issued.token)
    expect(row.revoked_at).toBeNull()
    expect(row.first_accessed_at).toBeNull()

    expect(await countEvents(requestId, 'access_token_issued')).toBe(1)
  })

  it('não emite token para solicitação inexistente', async () => {
    const res = await issueToken('00000000-0000-4000-8000-000000000000')
    expect(res.statusCode).toBe(404)
  })

  it('não emite token para solicitação cancelada (409)', async () => {
    const { requestId } = await createRequest('acc-emit-cancel')
    const cancelRes = await injectWithM2M(
      'POST',
      `/v1/information-requests/${requestId}/cancel?tenantId=${tenantId}`,
      { toState: 'cancelled', reason: 'Não é mais necessário' },
    )
    expect(cancelRes.statusCode).toBe(200)

    const res = await issueToken(requestId)
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('INVALID_STATE_TRANSITION')
    expect(await tokenRowsOf(requestId)).toHaveLength(0)
  })

  it('persiste expired (com evento) antes de responder 409 na emissão', async () => {
    const { requestId } = await createRequest(
      'acc-emit-expirada',
      undefined,
      new Date(Date.now() + 60_000).toISOString(),
    )
    await expireRequest(requestId)

    const res = await issueToken(requestId)
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('HOLDER_INFORMATION_REQUEST_EXPIRED')

    const rows = await adminSql`
      SELECT state, expired_at FROM holder_information_request WHERE id = ${requestId}`
    expect(rows[0]!.state).toBe('expired')
    expect(rows[0]!.expired_at).not.toBeNull()
    expect(await countEvents(requestId, 'expired')).toBe(1)
    expect(await tokenRowsOf(requestId)).toHaveLength(0)
  })

  it('calcula a expiração com o relógio do PostgreSQL e respeita o prazo da solicitação', async () => {
    const { requestId } = await createRequest('acc-emit-db-clock')
    // Prazo bem menor que o TTL padrão de 7 dias: o token deve ser limitado
    // pelo `expires_at` da solicitação (relógio do banco).
    await adminSql`
      UPDATE holder_information_request
         SET expires_at = clock_timestamp() + interval '90 minutes'
       WHERE id = ${requestId}`

    const issued = await issueTokenOk(requestId)
    const [row] = await adminSql`
      SELECT expires_at FROM holder_information_request WHERE id = ${requestId}`

    const requestExpiresAt = (row!.expires_at as Date).getTime()
    const tokenExpiresAt = new Date(issued.expiresAt).getTime()
    const createdAt = new Date(issued.createdAt).getTime()

    expect(tokenExpiresAt).toBe(requestExpiresAt)
    expect(tokenExpiresAt).toBeGreaterThan(createdAt)
    expect(tokenExpiresAt).toBeGreaterThan(Date.now() + 60 * 60_000)
    expect(tokenExpiresAt).toBeLessThan(Date.now() + 2 * 60 * 60_000)

    // Nenhum token além do prazo da solicitação foi emitido.
    const tokens = await tokenRowsOf(requestId)
    expect(tokens).toHaveLength(1)
    expect((tokens[0]!.expires_at as Date).getTime()).toBeLessThanOrEqual(requestExpiresAt)
  })

  it('não emite token quando a solicitação vence antes da escrita (relógio do banco)', async () => {
    const { requestId } = await createRequest('acc-emit-race')
    // Janela mínima: a solicitação está válida, mas vence em 150 ms no relógio
    // do PostgreSQL. Após a espera, a emissão deve persistir `expired` e
    // responder 409 sem criar token.
    await adminSql`
      UPDATE holder_information_request
         SET expires_at = clock_timestamp() + interval '150 milliseconds'
       WHERE id = ${requestId}`
    await new Promise((resolve) => setTimeout(resolve, 300))

    const res = await issueToken(requestId)
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('HOLDER_INFORMATION_REQUEST_EXPIRED')

    const [row] = await adminSql`
      SELECT state FROM holder_information_request WHERE id = ${requestId}`
    expect(row!.state).toBe('expired')
    expect(await tokenRowsOf(requestId)).toHaveLength(0)
  })

  it('expiração do token nunca fica antes da criação (constraint do banco)', async () => {
    const { requestId } = await createRequest('acc-emit-expiry-constraint')
    const issued = await issueTokenOk(requestId)
    const tokens = await tokenRowsOf(requestId)
    expect(tokens).toHaveLength(1)
    const row = tokens[0]!
    expect((row.expires_at as Date).getTime()).toBeGreaterThan((row.created_at as Date).getTime())
    expect(issued.expiresAt).toBe((row.expires_at as Date).toISOString())
  })

  it('emissão responde Cache-Control: no-store (sucesso e erro)', async () => {
    const { requestId } = await createRequest('acc-emit-cache')
    const created = await issueToken(requestId)
    expect(created.statusCode).toBe(201)
    expect(created.headers['cache-control']).toBe('no-store')

    const missing = await issueToken(randomUUID())
    expect(missing.statusCode).toBe(404)
    expect(missing.headers['cache-control']).toBe('no-store')
  })

  it('limita a 5 tokens ativos; revogados não contam', async () => {
    const { requestId } = await createRequest('acc-emit-limite')
    for (let i = 0; i < 5; i += 1) {
      expect((await issueToken(requestId)).statusCode).toBe(201)
    }
    const sixth = await issueToken(requestId)
    expect(sixth.statusCode).toBe(429)
    expect(sixth.json().code).toBe('HOLDER_ACCESS_TOKEN_LIMIT')
    expect(await tokenRowsOf(requestId)).toHaveLength(5)

    // Revoga um: libera uma vaga.
    const tokens = await tokenRowsOf(requestId)
    const revokeRes = await injectWithM2M(
      'DELETE',
      `/v1/information-requests/${requestId}/access-tokens/${tokens[0]!.token_id}?tenantId=${tenantId}`,
    )
    expect(revokeRes.statusCode).toBe(204)

    expect((await issueToken(requestId)).statusCode).toBe(201)
    const after = await adminSql`
      SELECT count(*)::int AS n FROM holder_access_token
      WHERE holder_information_request_id = ${requestId} AND revoked_at IS NULL`
    expect(after[0]!.n).toBe(5)
    expect(await tokenRowsOf(requestId)).toHaveLength(6)
  })

  it('validade do token é limitada pelo prazo da solicitação', async () => {
    const cap = Date.now() + 2 * 24 * 3600_000
    const { requestId } = await createRequest('acc-emit-cap', undefined, new Date(cap).toISOString())
    const issued = await issueTokenOk(requestId)
    const expiresAt = new Date(issued.expiresAt).getTime()
    expect(expiresAt).toBeLessThanOrEqual(cap)
    expect(expiresAt).toBeGreaterThan(Date.now() + 1 * 24 * 3600_000)
  })

  it('revoga token: 204 idempotente, 404 para desconhecido e evento', async () => {
    const { requestId } = await createRequest('acc-revoke')
    const issued = await issueTokenOk(requestId)

    const first = await injectWithM2M(
      'DELETE',
      `/v1/information-requests/${requestId}/access-tokens/${issued.tokenId}?tenantId=${tenantId}`,
    )
    expect(first.statusCode).toBe(204)

    const again = await injectWithM2M(
      'DELETE',
      `/v1/information-requests/${requestId}/access-tokens/${issued.tokenId}?tenantId=${tenantId}`,
    )
    expect(again.statusCode).toBe(204)

    const unknown = await injectWithM2M(
      'DELETE',
      `/v1/information-requests/${requestId}/access-tokens/${randomUUID()}?tenantId=${tenantId}`,
    )
    expect(unknown.statusCode).toBe(404)

    expect(await countEvents(requestId, 'access_token_revoked')).toBe(1)
    const rows = await tokenRowsOf(requestId)
    expect(rows[0]!.revoked_at).not.toBeNull()

    // Token revogado não resolve mais.
    const view = await injectAsHolder('GET', '/v1/holder-access', issued.token)
    expect(view.statusCode).toBe(401)
  })
})

describe('F4.2 — acesso do Holder', () => {
  it('sem token, malformado ou desconhecido → 401', async () => {
    const { requestId } = await createRequest('acc-auth')
    await issueTokenOk(requestId)

    const missing = await injectAsHolder('GET', '/v1/holder-access', undefined)
    expect(missing.statusCode).toBe(401)

    const malformed = await injectAsHolder('GET', '/v1/holder-access', 'hlt_malformado')
    expect(malformed.statusCode).toBe(401)

    const unknownToken = `hlt_${'z'.repeat(43)}`
    const unknown = await injectAsHolder('GET', '/v1/holder-access', unknownToken)
    expect(unknown.statusCode).toBe(401)
  })

  it('holder consulta a solicitação com token válido (sem dados do Verifier)', async () => {
    const { requestId, holderId } = await createRequest('acc-view', [
      {
        itemId: 'address-proof',
        description: 'Comprovante',
        required: true,
        documentType: 'proof_of_address',
      },
      { itemId: 'observations', description: 'Observações', required: false },
    ])
    const issued = await issueTokenOk(requestId)

    const res = await injectAsHolder('GET', '/v1/holder-access', issued.token)
    expect(res.statusCode).toBe(200)
    const view = res.json()
    expect(view.requestId).toBe(requestId)
    expect(view.state).toBe('pending')
    expect(view.purpose).toBe('Comprovante de residência')
    expect(view.items).toHaveLength(2)
    expect(view.items[0].itemId).toBe('address-proof')
    expect(view.items[0].required).toBe(true)
    expect(view.items[0].documentType).toBe('proof_of_address')
    expect(view.items[0].value).toBeNull()
    expect(view.items[0].documents).toEqual([])
    // Nunca expõe tenant/holder/criador.
    expect(view).not.toHaveProperty('holderId')
    expect(JSON.stringify(view)).not.toContain(tenantId)
    expect(JSON.stringify(view)).not.toContain(holderId)
    expect(JSON.stringify(view)).not.toContain('createdBy')

    expect(await countEvents(requestId, 'holder_accessed')).toBe(1)
  })

  it('a assertion de não exposição falha se holderId for introduzido indevidamente', () => {
    // A assertion precisa operar sobre o objeto, não sobre a string do JSON.
    const view: Record<string, unknown> = { requestId: randomUUID(), items: [] }
    expect(view).not.toHaveProperty('holderId')
    expect(() => expect({ ...view, holderId: randomUUID() }).not.toHaveProperty('holderId')).toThrow()
  })

  it('registra holder_accessed no máximo uma vez por token', async () => {
    const { requestId } = await createRequest('acc-first-access')
    const issued = await issueTokenOk(requestId)

    await injectAsHolder('GET', '/v1/holder-access', issued.token)
    await injectAsHolder('GET', '/v1/holder-access', issued.token)
    await injectAsHolder('PUT', '/v1/holder-access/items/observations', issued.token, {
      payload: JSON.stringify({ value: 'ok' }),
      headers: { 'content-type': 'application/json' },
    })

    expect(await countEvents(requestId, 'holder_accessed')).toBe(1)
    const rows = await tokenRowsOf(requestId)
    expect(rows[0]!.first_accessed_at).not.toBeNull()
  })

  it('salva resposta textual com upsert e auditoria', async () => {
    const { requestId } = await createRequest('acc-save-item', [
      { itemId: 'observations', description: 'Observações', required: false },
    ])
    const issued = await issueTokenOk(requestId)

    const save = await injectAsHolder('PUT', '/v1/holder-access/items/observations', issued.token, {
      payload: JSON.stringify({ value: '  Moro no apto 101  ' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(save.statusCode).toBe(200)
    expect(save.json().items[0].value).toBe('Moro no apto 101')

    const update = await injectAsHolder('PUT', '/v1/holder-access/items/observations', issued.token, {
      payload: JSON.stringify({ value: 'Resposta atualizada' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(update.statusCode).toBe(200)
    expect(update.json().items[0].value).toBe('Resposta atualizada')

    const rows = await adminSql`
      SELECT value FROM holder_item_response WHERE holder_information_request_id = ${requestId}`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.value).toBe('Resposta atualizada')
    expect(await countEvents(requestId, 'holder_response_saved')).toBe(2)
  })

  it('rejeita item inexistente (404) e valor vazio (400)', async () => {
    const { requestId } = await createRequest('acc-save-invalid', [
      { itemId: 'observations', description: 'Observações', required: false },
    ])
    const issued = await issueTokenOk(requestId)

    const missing = await injectAsHolder('PUT', '/v1/holder-access/items/nao-existe', issued.token, {
      payload: JSON.stringify({ value: 'x' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(missing.statusCode).toBe(404)

    const empty = await injectAsHolder('PUT', '/v1/holder-access/items/observations', issued.token, {
      payload: JSON.stringify({ value: '   ' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(empty.statusCode).toBe(400)

    const huge = await injectAsHolder('PUT', '/v1/holder-access/items/observations', issued.token, {
      payload: JSON.stringify({ value: 'a'.repeat(5001) }),
      headers: { 'content-type': 'application/json' },
    })
    expect(huge.statusCode).toBe(400)

    expect(await countEvents(requestId, 'holder_response_saved')).toBe(0)
  })

  it('upload: intenção pendente commitada, finalize com metadados e auditoria', async () => {
    const { requestId } = await createRequest('acc-upload')
    const issued = await issueTokenOk(requestId)
    const documentId = await uploadDocumentOk(issued.token, 'address-proof', requestId)
    expect(documentId).toBeDefined()

    expect(await countEvents(requestId, 'holder_document_uploaded')).toBe(1)
    // Nenhuma intenção pendente remanescente.
    const pending = await adminSql`
      SELECT count(*)::int AS n FROM holder_information_request_document
      WHERE holder_information_request_id = ${requestId} AND upload_state = 'pending'`
    expect(pending[0]!.n).toBe(0)

    const view = await injectAsHolder('GET', '/v1/holder-access', issued.token)
    expect(view.statusCode).toBe(200)
    expect(view.json().items[0].documents).toHaveLength(1)
    expect(view.json().items[0].documents[0].contentType).toBe('image/png')
    expect(view.json().items[0].documents[0].sizeBytes).toBe(PNG_BYTES.byteLength)
  })

  it('upload rejeita magic bytes incompatíveis e conteúdo desconhecido', async () => {
    const { requestId } = await createRequest('acc-upload-invalid')
    const issued = await issueTokenOk(requestId)

    const mismatch = multipartPayload(PDF_BYTES, 'doc.png', 'image/png')
    const mismatchRes = await injectAsHolder(
      'POST',
      '/v1/holder-access/items/address-proof/documents',
      issued.token,
      { payload: mismatch.payload, headers: mismatch.headers },
    )
    expect(mismatchRes.statusCode).toBe(422)
    expect(mismatchRes.json().code).toBe('EVIDENCE_CONTENT_MISMATCH')

    const garbage = multipartPayload(Uint8Array.from([0, 1, 2, 3, 4]), 'doc.png', 'image/png')
    const garbageRes = await injectAsHolder(
      'POST',
      '/v1/holder-access/items/address-proof/documents',
      issued.token,
      { payload: garbage.payload, headers: garbage.headers },
    )
    expect(garbageRes.statusCode).toBe(415)

    // Content-Type genérico com conteúdo válido é aceito.
    const generic = multipartPayload(PNG_BYTES, 'doc.bin', 'application/octet-stream')
    const genericRes = await injectAsHolder(
      'POST',
      '/v1/holder-access/items/address-proof/documents',
      issued.token,
      { payload: generic.payload, headers: generic.headers },
    )
    expect(genericRes.statusCode).toBe(200)

    expect(await countEvents(requestId, 'holder_document_uploaded')).toBe(1)
  })

  it('upload em item sem documentType → 422; item inexistente → 404', async () => {
    const { requestId } = await createRequest('acc-upload-item', [
      { itemId: 'text-only', description: 'Só texto', required: true },
    ])
    const issued = await issueTokenOk(requestId)

    const notDocument = multipartPayload(PNG_BYTES)
    const notDocumentRes = await injectAsHolder(
      'POST',
      '/v1/holder-access/items/text-only/documents',
      issued.token,
      { payload: notDocument.payload, headers: notDocument.headers },
    )
    expect(notDocumentRes.statusCode).toBe(422)
    expect(notDocumentRes.json().code).toBe('ITEM_NOT_DOCUMENT')

    const missingItem = multipartPayload(PNG_BYTES)
    const missingItemRes = await injectAsHolder(
      'POST',
      '/v1/holder-access/items/nao-existe/documents',
      issued.token,
      { payload: missingItem.payload, headers: missingItem.headers },
    )
    expect(missingItemRes.statusCode).toBe(404)
    expect(await countEvents(requestId, 'holder_document_uploaded')).toBe(0)
  })

  it('remove documento: tombstone antes da remoção física, idempotente', async () => {
    const { requestId } = await createRequest('acc-delete-doc')
    const issued = await issueTokenOk(requestId)
    const documentId = await uploadDocumentOk(issued.token, 'address-proof', requestId)
    if (typeof documentId !== 'string') throw new Error('documento não gravado')

    const rowsBefore = await adminSql`
      SELECT storage_key FROM holder_information_request_document WHERE document_id = ${documentId}`
    const storageKey = rowsBefore[0]!.storage_key as string
    expect(storeObjects.has(storageKey)).toBe(true)

    const del = await injectAsHolder(
      'DELETE',
      `/v1/holder-access/items/address-proof/documents/${documentId}`,
      issued.token,
    )
    expect(del.statusCode).toBe(204)

    // Tombstone permanece; objeto físico foi removido.
    const rowsAfter = await adminSql`
      SELECT deleted_at, upload_state FROM holder_information_request_document WHERE document_id = ${documentId}`
    expect(rowsAfter[0]!.deleted_at).not.toBeNull()
    expect(storeObjects.has(storageKey)).toBe(false)
    expect(await countEvents(requestId, 'holder_document_removal_requested')).toBe(1)
    expect(await countEvents(requestId, 'holder_document_removed')).toBe(1)

    // DELETE idempotente.
    const delAgain = await injectAsHolder(
      'DELETE',
      `/v1/holder-access/items/address-proof/documents/${documentId}`,
      issued.token,
    )
    expect(delAgain.statusCode).toBe(204)
    expect(await countEvents(requestId, 'holder_document_removal_requested')).toBe(1)

    const view = await injectAsHolder('GET', '/v1/holder-access', issued.token)
    expect(view.json().items[0].documents).toEqual([])
  })

  it('delete de documento inexistente → 404', async () => {
    const { requestId } = await createRequest('acc-delete-missing')
    const issued = await issueTokenOk(requestId)
    const res = await injectAsHolder(
      'DELETE',
      `/v1/holder-access/items/address-proof/documents/${randomUUID()}`,
      issued.token,
    )
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('HOLDER_DOCUMENT_NOT_FOUND')
  })

  it('retry: falha na remoção física mantém tombstone e a próxima chamada repete o delete', async () => {
    const { requestId } = await createRequest('acc-delete-retry')
    const issued = await issueTokenOk(requestId)
    const documentId = await uploadDocumentOk(issued.token, 'address-proof', requestId)
    if (typeof documentId !== 'string') throw new Error('documento não gravado')

    const rowsBefore = await adminSql`
      SELECT storage_key FROM holder_information_request_document WHERE document_id = ${documentId}`
    const storageKey = rowsBefore[0]!.storage_key as string
    expect(storeObjects.has(storageKey)).toBe(true)

    const url = `/v1/holder-access/items/address-proof/documents/${documentId}`

    // Primeira tentativa: o storage falha. A API mantém o tombstone e responde
    // 204 (a operação é idempotente do ponto de vista do cliente).
    failingDeletesRemaining = 1
    const first = await injectAsHolder('DELETE', url, issued.token)
    expect(first.statusCode).toBe(204)

    const rowsAfterFailure = await adminSql`
      SELECT deleted_at FROM holder_information_request_document WHERE document_id = ${documentId}`
    expect(rowsAfterFailure[0]!.deleted_at).not.toBeNull()
    expect(storeObjects.has(storageKey)).toBe(true)
    expect(await countEvents(requestId, 'holder_document_removal_requested')).toBe(1)
    // O evento de remoção física só existe quando o objeto sai do storage.
    expect(await countEvents(requestId, 'holder_document_removed')).toBe(0)

    // Segunda tentativa: repete a remoção física e registra o evento.
    failingDeletesRemaining = 0
    const second = await injectAsHolder('DELETE', url, issued.token)
    expect(second.statusCode).toBe(204)
    expect(storeObjects.has(storageKey)).toBe(false)
    expect(deleteAttempts.get(storageKey)).toBe(2)
    expect(await countEvents(requestId, 'holder_document_removed')).toBe(1)
    expect(await countEvents(requestId, 'holder_document_removal_requested')).toBe(1)

    // Terceira chamada: idempotente, sem evento duplicado.
    const third = await injectAsHolder('DELETE', url, issued.token)
    expect(third.statusCode).toBe(204)
    expect(await countEvents(requestId, 'holder_document_removed')).toBe(1)
  })

  it('retry conclui o evento quando o storage já removeu mas o banco não concluiu', async () => {
    const { requestId } = await createRequest('acc-delete-db-after-storage')
    const issued = await issueTokenOk(requestId)
    const documentId = await uploadDocumentOk(issued.token, 'address-proof', requestId)
    if (typeof documentId !== 'string') throw new Error('documento não gravado')

    const [row] = await adminSql`
      SELECT storage_key FROM holder_information_request_document WHERE document_id = ${documentId}`
    const storageKey = row!.storage_key as string

    // Simula o estado deixado por uma falha de banco APÓS a exclusão física:
    // tombstone commitado, objeto já ausente do storage e nenhum evento
    // `holder_document_removed`. A próxima chamada deve concluir o processo.
    await adminSql`
      UPDATE holder_information_request_document
         SET deleted_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE document_id = ${documentId}`
    storeObjects.delete(storageKey)
    expect(await countEvents(requestId, 'holder_document_removed')).toBe(0)

    const url = `/v1/holder-access/items/address-proof/documents/${documentId}`
    const res = await injectAsHolder('DELETE', url, issued.token)
    expect(res.statusCode).toBe(204)
    expect(storeObjects.has(storageKey)).toBe(false)
    expect(await countEvents(requestId, 'holder_document_removed')).toBe(1)

    // Exclusão repetida com objeto já inexistente é idempotente.
    const again = await injectAsHolder('DELETE', url, issued.token)
    expect(again.statusCode).toBe(204)
    expect(await countEvents(requestId, 'holder_document_removed')).toBe(1)
    expect(await countEvents(requestId, 'holder_document_removal_requested')).toBe(0)
  })

  it('DELETE: token ausente, malformado ou desconhecido → 401 uniforme', async () => {
    const { requestId } = await createRequest('acc-delete-auth')
    const issued = await issueTokenOk(requestId)
    const url = `/v1/holder-access/items/address-proof/documents/${randomUUID()}`

    const missing = await injectAsHolder('DELETE', url, undefined)
    expect(missing.statusCode).toBe(401)
    expect(missing.json().code).toBe('HOLDER_ACCESS_UNAUTHORIZED')

    const malformed = await injectAsHolder('DELETE', url, 'hlt_malformado')
    expect(malformed.statusCode).toBe(401)
    expect(malformed.json().code).toBe('HOLDER_ACCESS_UNAUTHORIZED')

    const unknown = await injectAsHolder('DELETE', url, `hlt_${'z'.repeat(43)}`)
    expect(unknown.statusCode).toBe(401)
    expect(unknown.json().code).toBe('HOLDER_ACCESS_UNAUTHORIZED')

    // Token válido, documento inexistente → 404 (não confunde auth com recurso).
    const validToken = await injectAsHolder('DELETE', url, issued.token)
    expect(validToken.statusCode).toBe(404)
  })

  it('DELETE: token revogado → 401 (não 404)', async () => {
    const { requestId } = await createRequest('acc-delete-revoked')
    const issued = await issueTokenOk(requestId)
    const revoke = await injectWithM2M(
      'DELETE',
      `/v1/information-requests/${requestId}/access-tokens/${issued.tokenId}?tenantId=${tenantId}`,
    )
    expect(revoke.statusCode).toBe(204)

    const res = await injectAsHolder(
      'DELETE',
      `/v1/holder-access/items/address-proof/documents/${randomUUID()}`,
      issued.token,
    )
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('HOLDER_ACCESS_UNAUTHORIZED')
  })

  it('DELETE: token expirado → 401 (não 404)', async () => {
    const { requestId } = await createRequest('acc-delete-expired')
    const issued = await issueTokenOk(requestId)

    // `holder_access_token_expiry_check` exige expires_at > created_at: um
    // token vencido só pode ter sido criado antes do vencimento.
    const now = Date.now()
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx
        .update(t.holderAccessToken)
        .set({ createdAt: new Date(now - 120_000), expiresAt: new Date(now - 60_000) })
        .where(eq(t.holderAccessToken.tokenId, issued.tokenId))
    })

    const res = await injectAsHolder(
      'DELETE',
      `/v1/holder-access/items/address-proof/documents/${randomUUID()}`,
      issued.token,
    )
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('HOLDER_ACCESS_UNAUTHORIZED')
  })

  it('DELETE: solicitação cancelada → 401 uniforme (token revogado no cancelamento)', async () => {
    const { requestId } = await createRequest('acc-delete-cancelled')
    const issued = await issueTokenOk(requestId)
    const cancelRes = await injectWithM2M(
      'POST',
      `/v1/information-requests/${requestId}/cancel?tenantId=${tenantId}`,
      { toState: 'cancelled', reason: 'Cancelado' },
    )
    expect(cancelRes.statusCode).toBe(200)

    // O cancelamento revoga os tokens na mesma transação; a autenticação
    // falha antes de qualquer checagem de estado, sem revelar que a
    // solicitação existe (401, nunca 404/409).
    const res = await injectAsHolder(
      'DELETE',
      `/v1/holder-access/items/address-proof/documents/${randomUUID()}`,
      issued.token,
    )
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('HOLDER_ACCESS_UNAUTHORIZED')
  })

  it('DELETE: documento de outra solicitação → 404 e documento original intacto', async () => {
    const original = await createRequest('acc-delete-owner-a')
    const issuedOriginal = await issueTokenOk(original.requestId)
    const documentId = await uploadDocumentOk(issuedOriginal.token, 'address-proof', original.requestId)
    if (typeof documentId !== 'string') throw new Error('documento não gravado')

    // Outra solicitação do mesmo tenant, com o mesmo item.
    const other = await createRequest('acc-delete-owner-b')
    const issuedOther = await issueTokenOk(other.requestId)

    const res = await injectAsHolder(
      'DELETE',
      `/v1/holder-access/items/address-proof/documents/${documentId}`,
      issuedOther.token,
    )
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('HOLDER_DOCUMENT_NOT_FOUND')

    // O documento da solicitação original não foi tombstoned nem removido.
    const rows = await adminSql`
      SELECT deleted_at FROM holder_information_request_document WHERE document_id = ${documentId}`
    expect(rows[0]!.deleted_at).toBeNull()
    const view = await injectAsHolder('GET', '/v1/holder-access', issuedOriginal.token)
    expect(view.statusCode).toBe(200)
    expect(view.json().items[0].documents).toHaveLength(1)
  })

  it('DELETE: solicitação completed → 409 (não 404)', async () => {
    const { requestId } = await createRequest('acc-delete-completed', [
      { itemId: 'current-address', description: 'Endereço atual', required: true },
    ])
    const issued = await issueTokenOk(requestId)
    await injectAsHolder('PUT', '/v1/holder-access/items/current-address', issued.token, {
      payload: JSON.stringify({ value: 'Endereço' }),
      headers: { 'content-type': 'application/json' },
    })
    expect((await injectAsHolder('POST', '/v1/holder-access/submit', issued.token)).statusCode).toBe(200)

    const res = await injectAsHolder(
      'DELETE',
      `/v1/holder-access/items/current-address/documents/${randomUUID()}`,
      issued.token,
    )
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('HOLDER_INFORMATION_REQUEST_STATE')
  })

  it('Cache-Control: no-store em sucesso, erro de auth e erro de validação', async () => {
    const { requestId } = await createRequest('acc-cache')
    const issued = await issueTokenOk(requestId)

    const ok = await injectAsHolder('GET', '/v1/holder-access', issued.token)
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['cache-control']).toBe('no-store')

    const unauthorized = await injectAsHolder('GET', '/v1/holder-access', undefined)
    expect(unauthorized.statusCode).toBe(401)
    expect(unauthorized.headers['cache-control']).toBe('no-store')

    const invalidParams = await injectAsHolder(
      'DELETE',
      '/v1/holder-access/items/address-proof/documents/nao-e-uuid',
      issued.token,
    )
    expect(invalidParams.statusCode).toBe(400)
    expect(invalidParams.headers['cache-control']).toBe('no-store')

    const notFound = await injectAsHolder(
      'DELETE',
      `/v1/holder-access/items/address-proof/documents/${randomUUID()}`,
      issued.token,
    )
    expect(notFound.statusCode).toBe(404)
    expect(notFound.headers['cache-control']).toBe('no-store')

    // Token expirado → 401, também sem cache.
    const now = Date.now()
    await withTenant(appPool.db, tenantId, async (tx) => {
      await tx
        .update(t.holderAccessToken)
        .set({ createdAt: new Date(now - 120_000), expiresAt: new Date(now - 60_000) })
        .where(eq(t.holderAccessToken.tokenId, issued.tokenId))
    })
    const expired = await injectAsHolder('GET', '/v1/holder-access', issued.token)
    expect(expired.statusCode).toBe(401)
    expect(expired.headers['cache-control']).toBe('no-store')

    // Token revogado → 401, também sem cache.
    const revoke = await injectWithM2M(
      'DELETE',
      `/v1/information-requests/${requestId}/access-tokens/${issued.tokenId}?tenantId=${tenantId}`,
    )
    expect(revoke.statusCode).toBe(204)
    const revoked = await injectAsHolder('GET', '/v1/holder-access', issued.token)
    expect(revoked.statusCode).toBe(401)
    expect(revoked.headers['cache-control']).toBe('no-store')

    // Estado incompatível → 409, também sem cache.
    const completed = await createRequest('acc-cache-state', [
      { itemId: 'current-address', description: 'Endereço atual', required: true },
    ])
    const completedToken = await issueTokenOk(completed.requestId)
    await injectAsHolder('PUT', '/v1/holder-access/items/current-address', completedToken.token, {
      payload: JSON.stringify({ value: 'Endereço' }),
      headers: { 'content-type': 'application/json' },
    })
    expect((await injectAsHolder('POST', '/v1/holder-access/submit', completedToken.token)).statusCode).toBe(
      200,
    )
    const stateConflict = await injectAsHolder(
      'DELETE',
      `/v1/holder-access/items/current-address/documents/${randomUUID()}`,
      completedToken.token,
    )
    expect(stateConflict.statusCode).toBe(409)
    expect(stateConflict.headers['cache-control']).toBe('no-store')
  })
})

describe('F4.2 — submit do Holder', () => {
  it('submit exige itens obrigatórios (texto e documento)', async () => {
    const { requestId } = await createRequest('acc-submit-missing', [
      {
        itemId: 'address-proof',
        description: 'Comprovante',
        required: true,
        documentType: 'proof_of_address',
      },
      { itemId: 'current-address', description: 'Endereço atual', required: true },
      { itemId: 'notes', description: 'Observações', required: false },
    ])
    const issued = await issueTokenOk(requestId)

    const empty = await injectAsHolder('POST', '/v1/holder-access/submit', issued.token)
    expect(empty.statusCode).toBe(422)
    expect(empty.json().code).toBe('HOLDER_REQUIRED_ITEMS_MISSING')
    expect(empty.json().detail).toContain('address-proof')
    expect(empty.json().detail).toContain('current-address')

    const saveText = await injectAsHolder('PUT', '/v1/holder-access/items/current-address', issued.token, {
      payload: JSON.stringify({ value: 'Rua das Flores, 123' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(saveText.statusCode).toBe(200)

    const stillMissing = await injectAsHolder('POST', '/v1/holder-access/submit', issued.token)
    expect(stillMissing.statusCode).toBe(422)
    expect(stillMissing.json().detail).toContain('address-proof')
    expect(stillMissing.json().detail).not.toContain('current-address')
    expect(await countEvents(requestId, 'completed')).toBe(0)
  })

  it('submit válido completa atomicamente com um único evento', async () => {
    const { requestId } = await createRequest('acc-submit-ok', [
      {
        itemId: 'address-proof',
        description: 'Comprovante',
        required: true,
        documentType: 'proof_of_address',
      },
      { itemId: 'current-address', description: 'Endereço atual', required: true },
    ])
    const issued = await issueTokenOk(requestId)

    const saveText = await injectAsHolder('PUT', '/v1/holder-access/items/current-address', issued.token, {
      payload: JSON.stringify({ value: 'Rua das Flores, 123' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(saveText.statusCode).toBe(200)
    await uploadDocumentOk(issued.token, 'address-proof')

    const submit = await injectAsHolder('POST', '/v1/holder-access/submit', issued.token)
    expect(submit.statusCode).toBe(200)
    expect(submit.json().state).toBe('completed')
    expect(submit.json().completedAt).not.toBeNull()
    // Ordem dos itens é a da solicitação: [address-proof (documento), current-address (texto)].
    expect(submit.json().items[0].documents).toHaveLength(1)
    expect(submit.json().items[1].value).toBe('Rua das Flores, 123')

    const rows = await adminSql`
      SELECT state, completed_at FROM holder_information_request WHERE id = ${requestId}`
    expect(rows[0]!.state).toBe('completed')
    expect(rows[0]!.completed_at).not.toBeNull()
    expect(await countEvents(requestId, 'completed')).toBe(1)
    const events = await eventsOf(requestId)
    const completed = events.find((e) => e.event_type === 'completed')
    expect(completed!.actor).toBe(`holder-token:${issued.tokenId}`)
  })

  it('submit repetido é idempotente (200, sem segundo evento)', async () => {
    const { requestId } = await createRequest('acc-submit-idem', [
      { itemId: 'current-address', description: 'Endereço atual', required: true },
    ])
    const issued = await issueTokenOk(requestId)
    await injectAsHolder('PUT', '/v1/holder-access/items/current-address', issued.token, {
      payload: JSON.stringify({ value: 'Endereço' }),
      headers: { 'content-type': 'application/json' },
    })

    const first = await injectAsHolder('POST', '/v1/holder-access/submit', issued.token)
    expect(first.statusCode).toBe(200)
    const completedAt = first.json().completedAt

    const second = await injectAsHolder('POST', '/v1/holder-access/submit', issued.token)
    expect(second.statusCode).toBe(200)
    expect(second.json().state).toBe('completed')
    expect(second.json().completedAt).toBe(completedAt)
    expect(await countEvents(requestId, 'completed')).toBe(1)
  })

  it('após completed: leitura permitida, mutações 409', async () => {
    const { requestId } = await createRequest('acc-after-complete', [
      { itemId: 'current-address', description: 'Endereço atual', required: true },
    ])
    const issued = await issueTokenOk(requestId)
    await injectAsHolder('PUT', '/v1/holder-access/items/current-address', issued.token, {
      payload: JSON.stringify({ value: 'Endereço' }),
      headers: { 'content-type': 'application/json' },
    })
    expect((await injectAsHolder('POST', '/v1/holder-access/submit', issued.token)).statusCode).toBe(200)

    const view = await injectAsHolder('GET', '/v1/holder-access', issued.token)
    expect(view.statusCode).toBe(200)
    expect(view.json().state).toBe('completed')

    const save = await injectAsHolder('PUT', '/v1/holder-access/items/current-address', issued.token, {
      payload: JSON.stringify({ value: 'Nova resposta' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(save.statusCode).toBe(409)

    const part = multipartPayload(PNG_BYTES)
    const upload = await injectAsHolder(
      'POST',
      '/v1/holder-access/items/current-address/documents',
      issued.token,
      {
        payload: part.payload,
        headers: part.headers,
      },
    )
    expect(upload.statusCode).toBe(409)

    const submit = await injectAsHolder('POST', '/v1/holder-access/submit', issued.token)
    expect(submit.statusCode).toBe(200)
  })

  it('solicitação cancelada: token é revogado e holder recebe 401', async () => {
    const { requestId } = await createRequest('acc-cancelled')
    const issued = await issueTokenOk(requestId)
    const cancelRes = await injectWithM2M(
      'POST',
      `/v1/information-requests/${requestId}/cancel?tenantId=${tenantId}`,
      { toState: 'cancelled', reason: 'Cancelado' },
    )
    expect(cancelRes.statusCode).toBe(200)

    // O cancelamento revoga todos os tokens ativos: o token não resolve mais.
    const view = await injectAsHolder('GET', '/v1/holder-access', issued.token)
    expect(view.statusCode).toBe(401)
    expect(view.json().code).toBe('HOLDER_ACCESS_UNAUTHORIZED')
  })

  it('token com prazo vencido → 401 (resolver não retorna)', async () => {
    const { requestId } = await createRequest('acc-token-expired')
    const issued = await issueTokenOk(requestId)

    await withTenant(appPool.db, tenantId, async (tx) => {
      // `holder_access_token_expiry_check` exige expires_at > created_at: para
      // simular um token vencido, a criação também recua no tempo.
      const now = Date.now()
      await tx
        .update(t.holderAccessToken)
        .set({ createdAt: new Date(now - 120_000), expiresAt: new Date(now - 60_000) })
        .where(eq(t.holderAccessToken.tokenId, issued.tokenId))
    })

    const view = await injectAsHolder('GET', '/v1/holder-access', issued.token)
    expect(view.statusCode).toBe(401)
  })

  it('cancelamento da solicitação revoga tokens ativos', async () => {
    const { requestId } = await createRequest('acc-cancel-revoke')
    const issued = await issueTokenOk(requestId)
    const cancelRes = await injectWithM2M(
      'POST',
      `/v1/information-requests/${requestId}/cancel?tenantId=${tenantId}`,
      { toState: 'cancelled', reason: 'Revogar' },
    )
    expect(cancelRes.statusCode).toBe(200)

    const rows = await tokenRowsOf(requestId)
    expect(rows[0]!.revoked_at).not.toBeNull()
    expect(await countEvents(requestId, 'access_token_revoked')).toBe(1)
    const view = await injectAsHolder('GET', '/v1/holder-access', issued.token)
    expect(view.statusCode).toBe(401)
  })

  it('preflight CORS aceita o header X-Holder-Token', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/holder-access',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'x-holder-token',
      },
    })
    expect(res.statusCode).toBe(204)
    const allowHeaders = String(res.headers['access-control-allow-headers'] ?? '')
    expect(allowHeaders).toContain('x-holder-token')
  })
})

describe('F4.2 — concorrência', () => {
  it('emissões concorrentes respeitam o limite de 5 tokens ativos', async () => {
    const { requestId } = await createRequest('acc-cc-issue')
    const results = await Promise.all(Array.from({ length: 8 }, () => issueToken(requestId)))
    const created = results.filter((r) => r.statusCode === 201)
    const limited = results.filter((r) => r.statusCode === 429)
    expect(created.length).toBe(5)
    expect(limited.length).toBe(3)

    const active = await adminSql`
      SELECT count(*)::int AS n FROM holder_access_token
      WHERE holder_information_request_id = ${requestId} AND revoked_at IS NULL`
    expect(active[0]!.n).toBe(5)
  })

  it('primeiro acesso concorrente gera exatamente um evento', async () => {
    const { requestId } = await createRequest('acc-cc-first-access')
    const issued = await issueTokenOk(requestId)

    const views = await Promise.all(
      Array.from({ length: 6 }, () => injectAsHolder('GET', '/v1/holder-access', issued.token)),
    )
    expect(views.every((v) => v.statusCode === 200)).toBe(true)
    expect(await countEvents(requestId, 'holder_accessed')).toBe(1)
  })

  it('submit concorrente gera exatamente um evento completed e todos recebem 200', async () => {
    const { requestId } = await createRequest('acc-cc-submit', [
      { itemId: 'current-address', description: 'Endereço atual', required: true },
    ])
    const issued = await issueTokenOk(requestId)
    await injectAsHolder('PUT', '/v1/holder-access/items/current-address', issued.token, {
      payload: JSON.stringify({ value: 'Endereço' }),
      headers: { 'content-type': 'application/json' },
    })

    const submits = await Promise.all(
      Array.from({ length: 4 }, () => injectAsHolder('POST', '/v1/holder-access/submit', issued.token)),
    )
    expect(submits.every((s) => s.statusCode === 200)).toBe(true)
    expect(submits.every((s) => s.json().state === 'completed')).toBe(true)
    expect(await countEvents(requestId, 'completed')).toBe(1)
  })

  it('cancelamento concorrente com emissão: nenhum token permanece ativo', async () => {
    const { requestId } = await createRequest('acc-cc-cancel')
    const cancelPromise = injectWithM2M(
      'POST',
      `/v1/information-requests/${requestId}/cancel?tenantId=${tenantId}`,
      { toState: 'cancelled', reason: 'Concorrente' },
    )
    const issues = await Promise.all(Array.from({ length: 4 }, () => issueToken(requestId)))
    await cancelPromise

    const active = await adminSql`
      SELECT count(*)::int AS n FROM holder_access_token
      WHERE holder_information_request_id = ${requestId} AND revoked_at IS NULL`
    expect(active[0]!.n).toBe(0)

    // Toda emissão bem-sucedida foi revogada pelo cancelamento.
    const allRevoked = await adminSql`
      SELECT count(*)::int AS n FROM holder_access_token
      WHERE holder_information_request_id = ${requestId} AND revoked_at IS NOT NULL`
    expect(Number(allRevoked[0]!.n) + issues.filter((r) => r.statusCode !== 201).length).toBe(4)
  })
})
