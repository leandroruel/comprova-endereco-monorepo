import { createDbPool, makeApiKeyHasher, runMigrations, type Db } from '@comprova/db'
import { randomUUID } from 'node:crypto'
import * as t from '@comprova/db'
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
  const headers: Record<string, string> = {
    Cookie: `better-auth.session_token=${ownerSessionCookie}`,
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
    const createRes = await injectWithSession('POST', '/v1/m2m/api-keys?tenantId=' + m2mOrgTenantId, {
      name: 'Chave M2M Válida',
      scopes: ['validate:read', 'verify:m2m'],
      keyType: 'm2m',
    })
    expect(createRes.statusCode).toBe(201)
    const secret = createRes.json().secret

    // Nenhum cookie de sessão: somente Bearer token.
    const res = await injectBearer('GET', '/v1/meta', secret)
    expect(res.statusCode).toBe(200)
  })

  it('chave M2M sem scope suficiente é rejeitada com 403', async () => {
    const createRes = await injectWithSession('POST', '/v1/m2m/api-keys?tenantId=' + m2mOrgTenantId, {
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
    const res = await injectWithSession('POST', '/v1/m2m/api-keys?tenantId=' + m2mOrgTenantId, {
      name: 'Chave user com verify:m2m',
      scopes: ['verify:m2m'],
      keyType: 'user',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_SCOPE')
  })

  it('escopo desconhecido é rejeitado na criação da chave', async () => {
    const res = await injectWithSession('POST', '/v1/m2m/api-keys?tenantId=' + m2mOrgTenantId, {
      name: 'Chave com escopo desconhecido',
      scopes: ['validate:read', 'scope:inexistente'],
      keyType: 'm2m',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_SCOPE')
  })

  it('após revogação, a mesma chave é rejeitada imediatamente', async () => {
    const createRes = await injectWithSession('POST', '/v1/m2m/api-keys?tenantId=' + m2mOrgTenantId, {
      name: 'Chave para revogar',
      scopes: ['validate:read', 'verify:m2m'],
      keyType: 'm2m',
    })
    expect(createRes.statusCode).toBe(201)
    const keyId = createRes.json().apiKey.apiKeyId
    const secret = createRes.json().secret

    // Ainda válida antes da revogação.
    const before = await injectBearer('GET', '/v1/meta', secret)
    expect(before.statusCode).toBe(200)

    const revokeRes = await injectWithSession(
      'DELETE',
      `/v1/m2m/api-keys/${keyId}?tenantId=${m2mOrgTenantId}`,
      undefined,
    )
    expect(revokeRes.statusCode).toBe(200)

    // Imediatamente após a revogação (sem esperar o TTL do cache).
    const after = await injectBearer('GET', '/v1/meta', secret)
    expect(after.statusCode).toBe(401)
  })

  it('chave revogada não acessa endpoint protegido mesmo sem sessão', async () => {
    const createRes = await injectWithSession('POST', '/v1/m2m/api-keys?tenantId=' + m2mOrgTenantId, {
      name: 'Chave revogada',
      scopes: ['validate:read', 'verify:m2m'],
      keyType: 'm2m',
    })
    expect(createRes.statusCode).toBe(201)
    const keyId = createRes.json().apiKey.apiKeyId
    const secret = createRes.json().secret

    await injectWithSession('DELETE', `/v1/m2m/api-keys/${keyId}?tenantId=${m2mOrgTenantId}`, undefined)

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

describe('Verifier Separação user/M2M', () => {
  // Insere uma chave diretamente no banco, ignorando validações de criação.
  const insertApiKeyDirectly = async (
    tenantId: string,
    plaintext: string,
    scopes: string[],
    keyType: string,
    expired = false,
  ): Promise<{ apiKeyId: string; secret: string }> => {
    const apiKeyId = randomUUID()
    // Mesmo prefixo que keyPrefixOf(): primeiros 12 caracteres do plaintext.
    const prefix = plaintext.slice(0, 12)
    const hasher = makeApiKeyHasher(PEPPER)
    const keyHash = hasher.hash(plaintext)
    await (appPool.db as Db).insert(t.apiKey).values({
      apiKeyId,
      tenantId,
      keyPrefix: prefix,
      keyHash,
      scopes,
      keyType,
      revokedAt: null,
      expiresAt: expired ? new Date(Date.now() - 86_400_000) : null,
    })
    return { apiKeyId, secret: plaintext }
  }

  it('chave user via Bearer com keys:write acessa operações de gerenciamento de chaves', async () => {
    // Cria uma chave user diretamente no banco com keys:write.
    const { secret } = await insertApiKeyDirectly(
      m2mOrgTenantId,
      'user-key-direct-1234567890',
      ['validate:read', 'validate:write', 'keys:write'],
      'user',
    )

    // Chave user com keys:write pode acessar rota administrativa via Bearer.
    const res = await injectBearer('GET', '/v1/m2m/api-keys?tenantId=' + m2mOrgTenantId, secret)
    expect(res.statusCode).toBe(200)
  })

  it('chave m2m via Bearer sem keys:write é rejeitada em operações de gerenciamento', async () => {
    const { secret } = await insertApiKeyDirectly(
      m2mOrgTenantId,
      'm2m-key-direct-1234567890',
      ['validate:read', 'verify:m2m'],
      'm2m',
    )

    // Chave m2m sem keys:write é rejeitada em rota administrativa.
    const res = await injectBearer('GET', '/v1/m2m/api-keys?tenantId=' + m2mOrgTenantId, secret)
    expect(res.statusCode).toBe(403)
  })

  it('chave user com scope verify:m2m persistido é rejeitada na autenticação', async () => {
    const { secret } = await insertApiKeyDirectly(
      m2mOrgTenantId,
      'user-with-m2m-scope-1234567890',
      ['validate:read', 'verify:m2m'],
      'user',
    )

    const res = await injectBearer('GET', '/v1/meta', secret)
    expect(res.statusCode).toBe(401)
  })

  it('chave m2m com scope keys:write persistido é rejeitada na autenticação', async () => {
    const { secret } = await insertApiKeyDirectly(
      m2mOrgTenantId,
      'm2m-with-keys-write-1234567890',
      ['validate:read', 'keys:write'],
      'm2m',
    )

    const res = await injectBearer('GET', '/v1/meta', secret)
    expect(res.statusCode).toBe(401)
  })

  it('chave user via Bearer acessa /v1/meta com validate:read', async () => {
    const { secret } = await insertApiKeyDirectly(
      m2mOrgTenantId,
      'user-key-meta-1234567890',
      ['validate:read'],
      'user',
    )

    const res = await injectBearer('GET', '/v1/meta', secret)
    // Chave user com scope funcional pode acessar endpoints de consumo via Bearer.
    expect(res.statusCode).toBe(200)
  })

  it('chave m2m com verify:m2m e validate:read acessa /v1/meta', async () => {
    const { secret } = await insertApiKeyDirectly(
      m2mOrgTenantId,
      'm2m-valid-1234567890',
      ['validate:read', 'verify:m2m'],
      'm2m',
    )

    const res = await injectBearer('GET', '/v1/meta', secret)
    expect(res.statusCode).toBe(200)
  })

  it('chave m2m com verify:m2m mas sem validate:read é rejeitada em /v1/meta', async () => {
    const { secret } = await insertApiKeyDirectly(
      m2mOrgTenantId,
      'm2m-no-read-1234567890',
      ['verify:m2m'],
      'm2m',
    )

    const res = await injectBearer('GET', '/v1/meta', secret)
    // Tem verify:m2m mas falta validate:read.
    expect(res.statusCode).toBe(403)
  })

  it('sessão de usuário acessa operações administrativas de gerenciamento de chaves', async () => {
    const createRes = await injectWithSession('POST', '/v1/m2m/api-keys?tenantId=' + m2mOrgTenantId, {
      name: 'Chave via sessão',
      scopes: ['validate:read'],
      keyType: 'm2m',
    })
    expect(createRes.statusCode).toBe(201)

    const listRes = await injectWithSession('GET', '/v1/m2m/api-keys?tenantId=' + m2mOrgTenantId)
    expect(listRes.statusCode).toBe(200)
  })
})

describe('Verifier Integridade dos termos', () => {
  it('rejeita aceite de termos com versão desatualizada', async () => {
    // Cria organização (usa versão do servidor '1.0.0').
    const createRes = await injectWithSession('POST', '/v1/organizations', {
      name: 'Org Termos Desatualizados',
      termsVersion: '1.0.0',
    })
    expect(createRes.statusCode).toBe(201)
    const tenantId = createRes.json().tenantId

    // Tenta completar onboarding com versão diferente da vigente.
    const res = await injectWithSession('POST', `/v1/organizations/${tenantId}/onboarding/complete`, {
      termsVersion: '9.9.9',
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('TERMS_VERSION_MISMATCH')
  })

  it('aceita onboarding com versão vigente do servidor', async () => {
    const createRes = await injectWithSession('POST', '/v1/organizations', {
      name: 'Org Termos Válidos',
      termsVersion: '1.0.0',
    })
    expect(createRes.statusCode).toBe(201)
    const tenantId = createRes.json().tenantId

    const res = await injectWithSession('POST', `/v1/organizations/${tenantId}/onboarding/complete`, {
      termsVersion: '1.0.0',
    })
    expect(res.statusCode).toBe(200)
  })

  it('vincula aceite ao hash do documento dos termos', async () => {
    const createRes = await injectWithSession('POST', '/v1/organizations', {
      name: 'Org Termos com Hash',
      termsVersion: '1.0.0',
    })
    expect(createRes.statusCode).toBe(201)
    const tenantId = createRes.json().tenantId

    const res = await injectWithSession('POST', `/v1/organizations/${tenantId}/onboarding/complete`, {
      termsVersion: '1.0.0',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().termsDocumentHash).toBe('sha256:abc123def456')
  })
})
