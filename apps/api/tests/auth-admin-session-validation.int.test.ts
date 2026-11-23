import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  TEST_APP_DB_PASSWORD,
  createApiKey,
  createTenant,
  startTestDb,
  startTestRedis,
} from '@comprova/testing'
import { createDbPool, eq, runMigrations, sql } from '@comprova/db'
import * as t from '@comprova/db'
import { hashPassword } from 'better-auth/crypto'
import Redis from 'ioredis'
import { createLogger, createMetrics } from '@comprova/observability'
import { buildApp } from '../src/app.js'

const PEPPER = 'test-pepper-admin-session-123'
const CNPJ = '11222333000181'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

// Garante que o app_user enxerga as tabelas de auth criadas pelas migrations.
await adminPool.db.execute(sql`GRANT USAGE ON SCHEMA public TO app_user`)
await adminPool.db.execute(sql`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO app_user`)

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
    POLICY_VERSION: '2026.14.1',
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

afterAll(async () => {
  await app.close()
  redis.disconnect()
  await adminPool.end()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

const cookieOf = (setCookie: string | string[] | undefined): string =>
  Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie ?? '')

const ADMIN_EMAIL = `admin-validations-${Date.now()}@exemplo.com`
const ADMIN_PASSWORD = 'SenhaForte123!'
const VERIFIER_EMAIL = `verifier-validations-${Date.now()}@exemplo.com`
const VERIFIER_PASSWORD = 'SenhaForte123!'

const tenantId = await createTenant(adminPool.db, { name: 'org-admin-session' })
const { plaintext: apiKey } = await createApiKey(adminPool.db, tenantId, PEPPER, {
  keyType: 'user',
  scopes: ['validate:read', 'validate:write'],
})

// Provisiona o admin como em produção (sign-up da instância admin é fechado).
const adminUserId = randomUUID()
await adminPool.db.execute(sql`
  INSERT INTO admin_user (id, name, email, email_verified, role)
  VALUES (${adminUserId}, 'Admin Session Test', ${ADMIN_EMAIL}, true, 'superadmin')
`)
await adminPool.db.execute(sql`
  INSERT INTO admin_account (id, account_id, provider_id, user_id, password)
  VALUES (${randomUUID()}, ${adminUserId}, 'credential', ${adminUserId}, ${await hashPassword(ADMIN_PASSWORD)})
`)

const adminSignIn = await app.inject({
  method: 'POST',
  url: '/v1/auth/admin/sign-in/email',
  body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
})
const adminCookie = cookieOf(adminSignIn.headers['set-cookie'])

// Verifier real (sign-up habilitado) vinculado à organização.
await app.inject({
  method: 'POST',
  url: '/v1/auth/verifier/sign-up/email',
  body: { email: VERIFIER_EMAIL, password: VERIFIER_PASSWORD, name: 'Verifier Session Test' },
})
const verifierSignIn = await app.inject({
  method: 'POST',
  url: '/v1/auth/verifier/sign-in/email',
  body: { email: VERIFIER_EMAIL, password: VERIFIER_PASSWORD },
})
const verifierCookie = cookieOf(verifierSignIn.headers['set-cookie'])

const [verifierUser] = await adminPool.db
  .select({ id: t.verifierAuthUser.id })
  .from(t.verifierAuthUser)
  .where(eq(t.verifierAuthUser.email, VERIFIER_EMAIL))
  .limit(1)
const verifierId = verifierUser?.id
if (verifierId === undefined) throw new Error('verifier user não provisionado')

await adminPool.db.insert(t.organizationMember).values({
  organizationMemberId: randomUUID(),
  tenantId,
  userId: verifierId,
  role: 'owner',
})

const input = {
  document: { type: 'CNPJ', value: CNPJ },
  address: null,
  legal_basis: 'FRAUD_PREVENTION',
}

const userIdOf = async (validationId: string): Promise<string | null | undefined> => {
  const [row] = await adminPool.db
    .select({ userId: t.validation.userId })
    .from(t.validation)
    .where(eq(t.validation.validationId, validationId))
    .limit(1)
  return row?.userId
}

describe('POST /v1/validations com sessão do dashboard admin', () => {
  it('o id do admin NÃO existe em verifier_user (cenário que quebrava a FK)', async () => {
    const rows = await adminPool.db
      .select({ id: t.verifierAuthUser.id })
      .from(t.verifierAuthUser)
      .where(eq(t.verifierAuthUser.id, adminUserId))
    expect(rows).toHaveLength(0)
  })

  it('cria a validação sem gravar admin_user.id em validation.user_id', async () => {
    // O dashboard admin envia o Bearer da API key e o cookie de sessão admin
    // na mesma request. Antes da correção, `validation.user_id` recebia
    // `admin_user.id` e a FK para `verifier_user` derrubava a request (500).
    const res = await app.inject({
      method: 'POST',
      url: '/v1/validations',
      headers: {
        authorization: `Bearer ${apiKey}`,
        cookie: adminCookie,
        origin: 'http://admin.localhost:5173',
        'content-type': 'application/json',
      },
      payload: input,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { validation_id: string }
    await expect(userIdOf(body.validation_id)).resolves.toBeNull()
  })

  it('sessão do Verifier continua registrando o user_id do verifier_user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/validations?tenantId=${tenantId}`,
      headers: {
        cookie: verifierCookie,
        origin: 'http://verifier.localhost:5174',
        'content-type': 'application/json',
      },
      payload: input,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { validation_id: string }
    await expect(userIdOf(body.validation_id)).resolves.toBe(verifierId)
  })
})
