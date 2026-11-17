import { afterAll, describe, expect, it } from 'vitest'
import { startTestDb, startTestRedis, TEST_APP_DB_PASSWORD } from '@comprova/testing'
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

describe('fluxo real de autenticação do Verifier (convites e identidade)', () => {
  it('cenário 7: fluxo de convite e aceite funciona com identidade verifier_user', async () => {
    const email = `flow-invite-${Date.now()}@exemplo.com`
    const tokenA = await signUpAndIn(email, 'SenhaForte123!', 'Inviter')

    const orgId = await createOrg(tokenA, 'Org Convite')

    const inviteeEmail = `invitee-${Date.now()}@exemplo.com`
    const inviteRes = await injectWithSession(
      'POST',
      `/v1/organizations/${orgId}/invitations`,
      `verifier-auth.session_token=${tokenA}`,
      { email: inviteeEmail, role: 'member', expiresInDays: 7 },
    )
    expect(inviteRes.statusCode).toBe(201)
    const inviteToken = inviteRes.json().token
    expect(inviteToken).toBeDefined()

    const passwordB = 'SenhaForte123!'
    await app.inject({
      method: 'POST',
      url: '/v1/auth/verifier/sign-up/email',
      body: { email: inviteeEmail, password: passwordB, name: 'Invitee' },
    })
    const tokenB = await signUpAndIn(inviteeEmail, passwordB, 'Invitee')

    const acceptRes = await injectWithSession(
      'POST',
      '/v1/organizations/invitations/accept',
      `verifier-auth.session_token=${tokenB}`,
      { token: inviteToken },
    )
    expect(acceptRes.statusCode).toBe(200)
    expect(acceptRes.json().tenantId).toBe(orgId)
    expect(acceptRes.json().role).toBe('member')

    const userBRow = await adminPool.db
      .select({ id: t.verifierAuthUser.id })
      .from(t.verifierAuthUser)
      .where(eq(t.verifierAuthUser.email, inviteeEmail))
      .limit(1)
    expect(userBRow.length).toBe(1)
    const memberB = await adminPool.db
      .select({ userId: t.organizationMember.userId, role: t.organizationMember.role })
      .from(t.organizationMember)
      .where(and(eq(t.organizationMember.tenantId, orgId), eq(t.organizationMember.userId, userBRow[0]!.id)))
      .limit(1)
    expect(memberB.length).toBe(1)
    expect(memberB[0]!.role).toBe('member')
  })

  it('cenário 8: fluxo não depende de cadastro prévio na tabela legada user', async () => {
    const email = `flow-legacy-${Date.now()}@exemplo.com`
    const token = await signUpAndIn(email, 'SenhaForte123!', 'No Legacy')

    const orgId = await createOrg(token, 'Org No Legacy')

    const legacyUser = await adminPool.db
      .select({ id: sql<string>`1` })
      .from(sql`"user"`)
      .where(eq(sql`"user".email`, email))
      .limit(1)
    expect(legacyUser.length).toBe(0)

    const verifierUser = await adminPool.db
      .select({ id: t.verifierAuthUser.id })
      .from(t.verifierAuthUser)
      .where(eq(t.verifierAuthUser.email, email))
      .limit(1)
    expect(verifierUser.length).toBe(1)

    const member = await adminPool.db
      .select({ userId: t.organizationMember.userId })
      .from(t.organizationMember)
      .where(
        and(eq(t.organizationMember.tenantId, orgId), eq(t.organizationMember.userId, verifierUser[0]!.id)),
      )
      .limit(1)
    expect(member.length).toBe(1)
  })
})
