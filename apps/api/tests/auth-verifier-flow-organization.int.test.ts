import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTenant, startTestDb, startTestRedis, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import { runMigrations, createDbPool, sql, eq, and } from '@comprova/db'
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

describe('fluxo real de autenticação do Verifier (organizações)', () => {
  let tenantA: string

  beforeAll(async () => {
    tenantA = await createTenant(adminPool.db, { name: 'flow-org-a' })
  })

  it('cenário 3: Verifier autenticado cria organização e recebe membership de owner', async () => {
    const email = `flow-org-${Date.now()}@exemplo.com`
    const token = await signUpAndIn(email, 'SenhaForte123!', 'Verifier Org')

    const orgId = await createOrg(token, 'Minha Organização')
    expect(orgId).toBeDefined()

    const userRow = await adminPool.db
      .select({ id: t.verifierAuthUser.id })
      .from(t.verifierAuthUser)
      .where(eq(t.verifierAuthUser.email, email))
      .limit(1)
    const member = await adminPool.db
      .select({ role: t.organizationMember.role, userId: t.organizationMember.userId })
      .from(t.organizationMember)
      .where(and(eq(t.organizationMember.tenantId, orgId), eq(t.organizationMember.userId, userRow[0]!.id)))
      .limit(1)
    expect(member.length).toBe(1)
    expect(member[0]!.role).toBe('owner')
  })

  it('cenário 4: Verifier autenticado acessa rotas protegidas da própria organização', async () => {
    const email = `flow-prot-${Date.now()}@exemplo.com`
    const token = await signUpAndIn(email, 'SenhaForte123!', 'Verifier Prot')

    const orgId = await createOrg(token, 'Org Protegida')

    const listRes = await injectWithSession(
      'GET',
      '/v1/organizations',
      `verifier-auth.session_token=${token}`,
    )
    expect(listRes.statusCode).toBe(200)
    expect(listRes.json().some((o: { tenantId: string }) => o.tenantId === orgId)).toBe(true)

    const getRes = await injectWithSession(
      'GET',
      `/v1/organizations/${orgId}`,
      `verifier-auth.session_token=${token}`,
    )
    expect(getRes.statusCode).toBe(200)
    expect(getRes.json().tenantId).toBe(orgId)
  })

  it('cenário 5: usuário autenticado sem membership recebe 403 em rota de outra organização', async () => {
    const email = `flow-nomem-${Date.now()}@exemplo.com`
    const token = await signUpAndIn(email, 'SenhaForte123!', 'Verifier NoMem')

    const res = await injectWithSession(
      'GET',
      `/v1/organizations/${tenantA}`,
      `verifier-auth.session_token=${token}`,
    )
    expect(res.statusCode).toBe(403)
  })

  it('cenário 6: usuário de outro tenant não consegue acessar recursos do tenant', async () => {
    const email = `flow-cross-${Date.now()}@exemplo.com`
    const token = await signUpAndIn(email, 'SenhaForte123!', 'Verifier Cross')

    const orgIdA = await createOrg(token, 'Org Cross A')

    const email2 = `flow-cross2-${Date.now()}@exemplo.com`
    await signUpAndIn(email2, 'SenhaForte123!', 'Verifier Cross2')
    const token2 = await signUpAndIn(email2, 'SenhaForte123!', 'Verifier Cross2')

    const crossRes = await injectWithSession(
      'GET',
      `/v1/organizations/${orgIdA}`,
      `verifier-auth.session_token=${token2}`,
    )
    expect(crossRes.statusCode).toBe(403)
  })
})
