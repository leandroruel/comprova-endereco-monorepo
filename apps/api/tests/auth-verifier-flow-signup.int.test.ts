import { afterAll, describe, expect, it } from 'vitest'
import { startTestDb, startTestRedis, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import { runMigrations, createDbPool, sql, eq } from '@comprova/db'
import Redis from 'ioredis'
import { createLogger, createMetrics } from '@comprova/observability'
import { buildApp } from '../src/app.js'
import * as t from '@comprova/db'

const PEPPER = 'test-pepper-flow-123'

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

describe('fluxo real de autenticação do Verifier (cadastro e sessão)', () => {
  it('cenário 1: novo Verifier se cadastra e autentica via fluxo HTTP real', async () => {
    const email = `flow-${Date.now()}@exemplo.com`
    await signUpAndIn(email, 'SenhaForte123!', 'Verifier Flow')

    const userRow = await adminPool.db
      .select({ id: t.verifierAuthUser.id, email: t.verifierAuthUser.email })
      .from(t.verifierAuthUser)
      .where(eq(t.verifierAuthUser.email, email))
      .limit(1)
    expect(userRow.length).toBe(1)
    expect(userRow[0]!.email).toBe(email)

    const legacyUser = await adminPool.db
      .select({ id: sql<string>`1` })
      .from(sql`"user"`)
      .where(eq(sql`"user".email`, email))
      .limit(1)
    expect(legacyUser.length).toBe(0)
  })

  it('cenário 2: sessão criada é reconhecida pelo middleware (/api/me)', async () => {
    const email = `flow-me-${Date.now()}@exemplo.com`
    const token = await signUpAndIn(email, 'SenhaForte123!', 'Verifier Me')

    const me = await injectWithSession('GET', '/api/me', `verifier-auth.session_token=${token}`)
    expect(me.statusCode).toBe(200)
    expect(me.json().email).toBe(email)
    expect(me.json().id).toBeDefined()
  })
})
