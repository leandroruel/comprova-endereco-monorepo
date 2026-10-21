import { issuerScopeOf } from '@comprova/credential'
import { createDbPool, eq, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import { createLogger, createMetrics } from '@comprova/observability'
import {
  createApiKey,
  createIssuerSigningKey,
  createSubject,
  createTenant,
  createTestCredentialSigningKey,
  createValidation,
  seedGoldenDataset,
  signingKeysConfig,
  startTestDb,
  startTestRedis,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import Redis from 'ioredis'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { API_SCOPES } from '../src/plugins/scope.js'

const PEPPER = 'test-pepper-123'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
await seedGoldenDataset(adminPool.db)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

const readTenant = await createTenant(adminPool.db, { name: 'authz-read' })
const readKey = await createApiKey(adminPool.db, readTenant, PEPPER, {
  scopes: [API_SCOPES.validateRead],
})
const readSubject = await createSubject(adminPool.db, readTenant)
const readValidation = await createValidation(adminPool.db, readTenant, readSubject, {
  verdict: 'RESIDENTIAL',
  explanationSummary: 'Endereco parece residencial.',
})
const readSigning = createTestCredentialSigningKey('authz-read-key')
await createIssuerSigningKey(adminPool.db, readTenant, readSigning)

const writeTenant = await createTenant(adminPool.db, { name: 'authz-write' })
const writeKey = await createApiKey(adminPool.db, writeTenant, PEPPER, {
  scopes: [API_SCOPES.validateWrite],
})
const writeSubject = await createSubject(adminPool.db, writeTenant)
const writeValidation = await createValidation(adminPool.db, writeTenant, writeSubject, {
  verdict: 'RESIDENTIAL',
  explanationSummary: 'Endereco parece residencial.',
})
const writeSigning = createTestCredentialSigningKey('authz-write-key')
await createIssuerSigningKey(adminPool.db, writeTenant, writeSigning)

// Chave administrativa: só `keys:write`, sem leitura nem escrita de validação.
// Prova que o novo scope autoriza a revogação da própria signing key e nada mais.
const keysTenant = await createTenant(adminPool.db, { name: 'authz-keys' })
const keysKey = await createApiKey(adminPool.db, keysTenant, PEPPER, {
  scopes: [API_SCOPES.keysWrite],
})
const keysSigning = createTestCredentialSigningKey('authz-keys-key')
await createIssuerSigningKey(adminPool.db, keysTenant, keysSigning)

const fullTenant = await createTenant(adminPool.db, { name: 'authz-full' })
const fullKey = await createApiKey(adminPool.db, fullTenant, PEPPER)
const fullSubject = await createSubject(adminPool.db, fullTenant)
const fullValidation = await createValidation(adminPool.db, fullTenant, fullSubject, {
  verdict: 'RESIDENTIAL',
  explanationSummary: 'Endereco parece residencial.',
})

const otherTenant = await createTenant(adminPool.db, { name: 'authz-other' })
const otherKey = await createApiKey(adminPool.db, otherTenant, PEPPER)

// Credencial e signing key de `fullTenant`: usadas para provar que o scope
// correto de OUTRO tenant não atravessa o isolamento (404, não 403).
const fullCredentialId = randomBytes(32).toString('base64url')
await adminPool.db.insert(t.credentialStatus).values({
  credentialId: fullCredentialId,
  tenantId: fullTenant,
  issuerScope: issuerScopeOf(fullTenant),
  status: 'ACTIVE',
})
const fullSigningKey = createTestCredentialSigningKey('tenant-full-key')
await createIssuerSigningKey(adminPool.db, fullTenant, fullSigningKey)

const appPool = createDbPool(db.appUrl)
const app = await buildApp({
  config: {
    DATABASE_URL: db.appUrl,
    REDIS_URL: testRedis.url,
    API_KEY_PEPPER: PEPPER,
    CREDENTIAL_ISSUER_ORIGIN: 'https://issuer.test',
    CREDENTIAL_SIGNING_KEYS: signingKeysConfig([
      { tenantId: readTenant, key: readSigning },
      { tenantId: writeTenant, key: writeSigning },
      { tenantId: keysTenant, key: keysSigning },
      { tenantId: fullTenant, key: fullSigningKey },
    ]),
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

afterAll(async () => {
  await app.close()
  redis.disconnect()
  await adminPool.end()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

const auth = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` })
const authJson = (key: string): Record<string, string> => ({
  ...auth(key),
  'content-type': 'application/json',
})

interface RouteCase {
  readonly name: string
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly url: string
  readonly payload?: Record<string, unknown>
}

const expectForbidden = async (key: string, route: RouteCase): Promise<void> => {
  const res = await app.inject({
    method: route.method,
    url: route.url,
    headers: route.payload === undefined ? auth(key) : authJson(key),
    ...(route.payload === undefined ? {} : { payload: route.payload }),
  })
  expect(res.statusCode, route.name).toBe(403)
  expect(res.headers['content-type']).toContain('application/problem+json')
  expect(res.json().code).toBe('FORBIDDEN')
}

describe('scope enforcement', () => {
  it('API key com validate:read consulta validation do próprio tenant (200)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/validations/${readValidation}`,
      headers: auth(readKey.plaintext),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().validation_id).toBe(readValidation)
  })

  it('API key só com validate:write não consulta nenhuma rota de leitura (403)', async () => {
    const reads: readonly RouteCase[] = [
      { name: 'validation', method: 'GET', url: `/v1/validations/${writeValidation}` },
      { name: 'batches', method: 'GET', url: '/v1/batches' },
      { name: 'batch', method: 'GET', url: `/v1/batches/${randomUUID()}` },
      { name: 'batch export', method: 'GET', url: `/v1/batches/${randomUUID()}/export?format=json` },
      { name: 'stats', method: 'GET', url: '/v1/stats' },
      { name: 'meta', method: 'GET', url: '/v1/meta' },
      {
        name: 'subject validations',
        method: 'GET',
        url: `/v1/subjects/${writeSubject}/validations`,
      },
      { name: 'webhooks', method: 'GET', url: '/v1/webhooks' },
    ]

    for (const route of reads) await expectForbidden(writeKey.plaintext, route)
  })

  it('API key com validate:write cria validation (200)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/validations',
      headers: authJson(writeKey.plaintext),
      payload: {
        document: { type: 'CNPJ', value: '12345678000195' },
        address: null,
        mode: 'fast',
        legal_basis: 'FRAUD_PREVENTION',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().validation_id).toBeTypeOf('string')
  })

  it('API key com validate:write contesta validation (200)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/validations/${writeValidation}/contest`,
      headers: authJson(writeKey.plaintext),
      payload: { reason: 'Contestacao suficientemente longa.' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ contested: true, validation_id: writeValidation })
  })

  it('API key só com validate:write não revoga signing key (403, sem efeito)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/signing-keys/${writeSigning.keyId}/revoke`,
      headers: auth(writeKey.plaintext),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('FORBIDDEN')

    const [signingKey] = await adminPool.db
      .select({ revokedAt: t.issuerSigningKey.revokedAt })
      .from(t.issuerSigningKey)
      .where(eq(t.issuerSigningKey.keyId, writeSigning.keyId))
    expect(signingKey?.revokedAt).toBeNull()
  })

  it('API key só com validate:read não revoga signing key (403, sem efeito)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/signing-keys/${readSigning.keyId}/revoke`,
      headers: auth(readKey.plaintext),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('FORBIDDEN')

    const [signingKey] = await adminPool.db
      .select({ revokedAt: t.issuerSigningKey.revokedAt })
      .from(t.issuerSigningKey)
      .where(eq(t.issuerSigningKey.keyId, readSigning.keyId))
    expect(signingKey?.revokedAt).toBeNull()
  })

  it('API key com validate:write emite e revoga credencial (200)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/validations',
      headers: authJson(writeKey.plaintext),
      payload: {
        document: { type: 'CNPJ', value: '12345678000195' },
        address: null,
        mode: 'fast',
        legal_basis: 'FRAUD_PREVENTION',
      },
    })
    expect(created.statusCode).toBe(200)
    const validationId = created.json().validation_id as string

    const issued = await app.inject({
      method: 'POST',
      url: `/v1/validations/${validationId}/credential`,
      headers: auth(writeKey.plaintext),
    })
    expect(issued.statusCode).toBe(200)
    const credential = issued.json() as { id: string }
    const credentialId = credential.id.slice(credential.id.lastIndexOf('/') + 1)

    const revoked = await app.inject({
      method: 'POST',
      url: `/v1/credentials/${credentialId}/revoke`,
      headers: auth(writeKey.plaintext),
    })
    expect(revoked.statusCode).toBe(200)
    expect(revoked.json().status).toBe('REVOKED')
  })

  it('API key com keys:write revoga signing key do próprio tenant (200)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/signing-keys/${keysSigning.keyId}/revoke`,
      headers: auth(keysKey.plaintext),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().key_id).toBe(keysSigning.keyId)

    const [signingKey] = await adminPool.db
      .select({ revokedAt: t.issuerSigningKey.revokedAt })
      .from(t.issuerSigningKey)
      .where(eq(t.issuerSigningKey.keyId, keysSigning.keyId))
    expect(signingKey?.revokedAt).not.toBeNull()
  })

  it('keys:write não autoriza escrita de validação/credencial', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/validations',
      headers: authJson(keysKey.plaintext),
      payload: {
        document: { type: 'CNPJ', value: '12345678000195' },
        address: null,
        mode: 'fast',
        legal_basis: 'FRAUD_PREVENTION',
      },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('FORBIDDEN')
  })

  it('API key só com validate:read não executa mutação alguma (403)', async () => {
    const fakeCredentialId = randomBytes(32).toString('base64url')
    const writes: readonly RouteCase[] = [
      {
        name: 'criar validation',
        method: 'POST',
        url: '/v1/validations',
        payload: {
          document: { type: 'CNPJ', value: '12345678000195' },
          address: null,
          mode: 'fast',
          legal_basis: 'FRAUD_PREVENTION',
        },
      },
      {
        name: 'contestar validation',
        method: 'POST',
        url: `/v1/validations/${readValidation}/contest`,
        payload: { reason: 'Contestacao suficientemente longa.' },
      },
      {
        name: 'emitir credential',
        method: 'POST',
        url: `/v1/validations/${readValidation}/credential`,
      },
      {
        name: 'revogar credential',
        method: 'POST',
        url: `/v1/credentials/${fakeCredentialId}/revoke`,
      },
      {
        name: 'revogar signing key',
        method: 'POST',
        url: '/v1/signing-keys/tenant-full-key/revoke',
      },
      {
        name: 'criar batch',
        method: 'POST',
        url: '/v1/batches',
        payload: {
          documents: [{ type: 'CNPJ', value: '12345678000195' }],
          mode: 'fast',
          legal_basis: 'FRAUD_PREVENTION',
        },
      },
      {
        name: 'criar webhook',
        method: 'POST',
        url: '/v1/webhooks',
        payload: { url: 'https://example.com/hook', events: ['validation.completed'] },
      },
      { name: 'remover webhook', method: 'DELETE', url: `/v1/webhooks/${randomUUID()}` },
      { name: 'apagar subject', method: 'DELETE', url: `/v1/subjects/${randomUUID()}` },
    ]

    for (const route of writes) await expectForbidden(readKey.plaintext, route)
  })

  it('API key sem keys:write não revoga signing key de outro tenant (403, sem efeito)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/signing-keys/${fullSigningKey.keyId}/revoke`,
      headers: auth(writeKey.plaintext),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('FORBIDDEN')

    const [signingKey] = await adminPool.db
      .select({ revokedAt: t.issuerSigningKey.revokedAt })
      .from(t.issuerSigningKey)
      .where(eq(t.issuerSigningKey.keyId, fullSigningKey.keyId))
    expect(signingKey?.revokedAt).toBeNull()
  })

  it('scope correto não escapa do tenant: leitura e revogação alheias dão 404', async () => {
    const crossRead = await app.inject({
      method: 'GET',
      url: `/v1/validations/${fullValidation}`,
      headers: auth(otherKey.plaintext),
    })
    expect(crossRead.statusCode).toBe(404)
    expect(crossRead.json().code).toBe('NOT_FOUND')

    // Emissão também é escopada pelo tenant: B não emite para uma validation de
    // A mesmo com a signing key de A configurada no processo.
    const fullValidationViaHttp = await app.inject({
      method: 'POST',
      url: '/v1/validations',
      headers: authJson(fullKey.plaintext),
      payload: {
        document: { type: 'CNPJ', value: '12345678000195' },
        address: null,
        mode: 'fast',
        legal_basis: 'FRAUD_PREVENTION',
      },
    })
    expect(fullValidationViaHttp.statusCode).toBe(200)
    const fullValidationId = fullValidationViaHttp.json().validation_id as string

    const crossIssue = await app.inject({
      method: 'POST',
      url: `/v1/validations/${fullValidationId}/credential`,
      headers: auth(otherKey.plaintext),
    })
    expect(crossIssue.statusCode).toBe(404)
    expect(crossIssue.json().code).toBe('NOT_FOUND')
    const issuances = await adminPool.db
      .select()
      .from(t.credentialIssuance)
      .where(eq(t.credentialIssuance.validationId, fullValidationId))
    expect(issuances).toHaveLength(0)

    const crossSubject = await app.inject({
      method: 'GET',
      url: `/v1/subjects/${fullSubject}/validations`,
      headers: auth(otherKey.plaintext),
    })
    expect(crossSubject.statusCode).toBe(404)

    const crossRevoke = await app.inject({
      method: 'POST',
      url: `/v1/credentials/${fullCredentialId}/revoke`,
      headers: auth(otherKey.plaintext),
    })
    expect(crossRevoke.statusCode).toBe(404)
    expect(crossRevoke.json().code).toBe('NOT_FOUND')

    const [credential] = await adminPool.db
      .select()
      .from(t.credentialStatus)
      .where(eq(t.credentialStatus.credentialId, fullCredentialId))
    expect(credential?.status).toBe('ACTIVE')

    const crossSigning = await app.inject({
      method: 'POST',
      url: `/v1/signing-keys/${fullSigningKey.keyId}/revoke`,
      // `keysKey` tem o scope exigido, mas é de outro tenant: o guard passa e
      // o RLS devolve 404, sem revelar se a chave existe.
      headers: auth(keysKey.plaintext),
    })
    expect(crossSigning.statusCode).toBe(404)

    const [signingKey] = await adminPool.db
      .select()
      .from(t.issuerSigningKey)
      .where(eq(t.issuerSigningKey.keyId, fullSigningKey.keyId))
    expect(signingKey?.revokedAt).toBeNull()
  })

  it('key criada com o default não recebe keys:write implicitamente', async () => {
    const [apiKey] = await adminPool.db
      .select({ scopes: t.apiKey.scopes })
      .from(t.apiKey)
      .where(eq(t.apiKey.apiKeyId, fullKey.apiKeyId))
    expect(apiKey?.scopes).toEqual([API_SCOPES.validateRead, API_SCOPES.validateWrite])
    expect(apiKey?.scopes).not.toContain(API_SCOPES.keysWrite)

    const res = await app.inject({
      method: 'POST',
      url: `/v1/signing-keys/${fullSigningKey.keyId}/revoke`,
      headers: auth(fullKey.plaintext),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('FORBIDDEN')

    const [signingKey] = await adminPool.db
      .select({ revokedAt: t.issuerSigningKey.revokedAt })
      .from(t.issuerSigningKey)
      .where(eq(t.issuerSigningKey.keyId, fullSigningKey.keyId))
    expect(signingKey?.revokedAt).toBeNull()
  })

  it('chave inválida continua 401, antes de qualquer decisão de scope', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/subjects/${randomUUID()}`,
      headers: auth('cvkdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('UNAUTHORIZED')
  })

  it('chave com os dois scopes pode ler e escrever', async () => {
    const read = await app.inject({
      method: 'GET',
      url: `/v1/validations/${fullValidation}`,
      headers: auth(fullKey.plaintext),
    })
    expect(read.statusCode).toBe(200)

    const write = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: authJson(fullKey.plaintext),
      payload: { url: 'https://example.com/hook', events: ['validation.completed'] },
    })
    expect(write.statusCode).toBe(200)
  })
})
