import { afterAll, describe, expect, it } from 'vitest'
import { startTestDb, startTestRedis, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import { runMigrations, createDbPool, sql, eq, and } from '@comprova/db'
import Redis from 'ioredis'
import { createLogger, createMetrics } from '@comprova/observability'
import { buildApp } from '../src/app.js'
import * as t from '@comprova/db'

const PEPPER = 'test-pepper-flow-validation'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

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

afterAll(async () => {
  await app.close()
  redis.disconnect()
  await adminPool.end()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

const VERIFIER_ORIGIN = 'http://verifier.localhost:5174'

const cookieToStr = (setCookie: string | string[] | undefined): string =>
  Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie ?? '')

const extractSessionToken = (setCookie: string | string[] | undefined): string => {
  const str = cookieToStr(setCookie)
  const match = str.match(/verifier-auth\.session_token=([^;]+)/)
  if (!match) throw new Error('verifier session token not found in set-cookie')
  return match[1]!
}

const injectWithSession = (method: string, url: string, cookieStr: string, body?: unknown) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieStr,
      origin: VERIFIER_ORIGIN,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

const signUpAndIn = async (email: string, password: string, name: string) => {
  await app.inject({
    method: 'POST',
    url: '/v1/auth/verifier/sign-up/email',
    body: { email, password, name },
  })
  const signIn = await app.inject({
    method: 'POST',
    url: '/v1/auth/verifier/sign-in/email',
    body: { email, password },
  })
  expect(signIn.statusCode).toBe(200)
  return extractSessionToken(signIn.headers['set-cookie'])
}

const createOrg = async (token: string, name: string) => {
  const res = await injectWithSession('POST', '/v1/organizations', `verifier-auth.session_token=${token}`, {
    name,
    legalName: `${name} LTDA`,
    document: '00.000.000/0001-00',
    termsVersion: '1.0.0',
    dataRegion: 'sa-east-1',
  })
  expect(res.statusCode).toBe(201)
  return res.json().tenantId
}

describe('fluxo real de autenticação do Verifier (criação de validação)', () => {
  it('cria validação com sessão real do Verifier e registra auditoria corretamente', async () => {
    const email = `flow-validation-${Date.now()}@exemplo.com`
    const token = await signUpAndIn(email, 'SenhaForte123!', 'Verifier Validation')

    // Cria organização e torna o usuário owner
    const orgId = await createOrg(token, 'Org Validation')

    // Cria um subject para a validação na organização criada
    await adminPool.db.insert(t.subject).values({
      subjectId: crypto.randomUUID(),
      tenantId: orgId,
      docType: 'CNPJ',
      docHmac: Buffer.from('doc-hmac-test'),
    })

    // Cria a validação via endpoint real (usa o tenantId da organização criada)
    const res = await injectWithSession(
      'POST',
      `/v1/validations?tenantId=${orgId}`,
      `verifier-auth.session_token=${token}`,
      {
        document: { type: 'CNPJ', value: '11222333000181' },
        legal_basis: 'FRAUD_PREVENTION',
        consent_ref: null,
      },
    )

    // A rota espera tenantId no query para sessão de usuário
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.validation_id).toBeDefined()
    expect(body.status).toBe('completed')

    // Verifica que validation.user_id referencia o verifier_user.id correto
    const userRow = await adminPool.db
      .select({ id: t.verifierAuthUser.id })
      .from(t.verifierAuthUser)
      .where(eq(t.verifierAuthUser.email, email))
      .limit(1)
    expect(userRow.length).toBe(1)

    const validationRow = await adminPool.db
      .select({ userId: t.validation.userId, tenantId: t.validation.tenantId })
      .from(t.validation)
      .where(eq(t.validation.validationId, body.validation_id))
      .limit(1)
    expect(validationRow.length).toBe(1)
    expect(validationRow[0]!.userId).toBe(userRow[0]!.id)
    expect(validationRow[0]!.tenantId).toBe(orgId)

    // Verifica que o audit_log registra a identidade da sessão
    const auditRow = await adminPool.db
      .select({ actor: t.auditLog.actor, action: t.auditLog.action })
      .from(t.auditLog)
      .where(and(eq(t.auditLog.targetId, body.validation_id), eq(t.auditLog.action, 'validation.create')))
      .limit(1)
    expect(auditRow.length).toBe(1)
    expect(auditRow[0]!.actor).toBe(`session:${userRow[0]!.id}`)
    expect(auditRow[0]!.action).toBe('validation.create')
  })
})
