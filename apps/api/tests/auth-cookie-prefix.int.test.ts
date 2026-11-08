import { afterAll, describe, expect, it } from 'vitest'
import {
  startTestDb,
  startTestRedis,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import { runMigrations, createDbPool, sql } from '@comprova/db'
import Redis from 'ioredis'
import { createLogger, createMetrics } from '@comprova/observability'
import { buildApp } from '../src/app.js'

const PEPPER = 'test-pepper-123'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

// Criar tabelas do better-auth admin (não cobertas pelas migrations do projeto)
await adminPool.db.execute(sql`
  CREATE TABLE IF NOT EXISTS admin_user (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    image TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    banned BOOLEAN NOT NULL DEFAULT FALSE,
    ban_reason TEXT,
    ban_expires TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )
`)
await adminPool.db.execute(sql`
  CREATE TABLE IF NOT EXISTS admin_session (
    id TEXT PRIMARY KEY,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    ip_address TEXT,
    user_agent TEXT,
    user_id TEXT NOT NULL REFERENCES admin_user(id),
    impersonated_by TEXT
  )
`)
await adminPool.db.execute(sql`
  CREATE TABLE IF NOT EXISTS admin_account (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES admin_user(id),
    access_token TEXT,
    refresh_token TEXT,
    id_token TEXT,
    access_token_expires_at TIMESTAMP WITH TIME ZONE,
    refresh_token_expires_at TIMESTAMP WITH TIME ZONE,
    scope TEXT,
    password TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )
`)
await adminPool.db.execute(sql`
  CREATE TABLE IF NOT EXISTS admin_verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )
`)

// Criar tabelas do better-auth verifier
await adminPool.db.execute(sql`
  CREATE TABLE IF NOT EXISTS verifier_user (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    image TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    banned BOOLEAN NOT NULL DEFAULT FALSE,
    ban_reason TEXT,
    ban_expires TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )
`)
await adminPool.db.execute(sql`
  CREATE TABLE IF NOT EXISTS verifier_session (
    id TEXT PRIMARY KEY,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    ip_address TEXT,
    user_agent TEXT,
    user_id TEXT NOT NULL REFERENCES verifier_user(id),
    impersonated_by TEXT
  )
`)
await adminPool.db.execute(sql`
  CREATE TABLE IF NOT EXISTS verifier_account (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES verifier_user(id),
    access_token TEXT,
    refresh_token TEXT,
    id_token TEXT,
    access_token_expires_at TIMESTAMP WITH TIME ZONE,
    refresh_token_expires_at TIMESTAMP WITH TIME ZONE,
    scope TEXT,
    password TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )
`)
await adminPool.db.execute(sql`
  CREATE TABLE IF NOT EXISTS verifier_verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )
`)

// Garante que o app_user (usado pelo buildApp) enxerga as tabelas criadas pelo superuser
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

const ADMIN_EMAIL = `admin-cookie-${Date.now()}@exemplo.com`
const ADMIN_PASSWORD = 'SenhaForte123!'
const VERIFIER_EMAIL = `verifier-cookie-${Date.now()}@exemplo.com`
const VERIFIER_PASSWORD = 'SenhaForte123!'

/**
 * Teste de isolamento de cookies de sessão entre as 3 instâncias do Better Auth.
 *
 * Cada instância usa um cookiePrefix distinto (admin-auth, verifier-auth,
 * legacy-auth) para que cookies de localhost não colidam entre dashboards.
 */
describe('auth cookie prefix isolation', () => {
  let adminSetCookie: string | string[] | undefined
  let verifierSetCookie: string | string[] | undefined

  it('admin sign-in seta cookie com prefixo admin-auth', async () => {
    // Primeiro cria o usuário via sign-up
    await app.inject({
      method: 'POST',
      url: '/v1/auth/admin/sign-up/email',
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin Cookie Test' },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/admin/sign-in/email',
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    })
    console.log('admin sign-in status:', res.statusCode)
    console.log('admin set-cookie:', res.headers['set-cookie'])

    expect(res.statusCode).toBe(200)

    adminSetCookie = res.headers['set-cookie']
    const adminCookieStr = Array.isArray(adminSetCookie) ? adminSetCookie.join('; ') : adminSetCookie
    expect(adminCookieStr).toContain('admin-auth.session_token=')
  })

  it('verifier sign-in seta cookie com prefixo verifier-auth', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/verifier/sign-up/email',
      body: { email: VERIFIER_EMAIL, password: VERIFIER_PASSWORD, name: 'Verifier Cookie Test' },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verifier/sign-in/email',
      body: { email: VERIFIER_EMAIL, password: VERIFIER_PASSWORD },
    })
    console.log('verifier sign-in status:', res.statusCode)
    console.log('verifier set-cookie:', res.headers['set-cookie'])

    expect(res.statusCode).toBe(200)

    verifierSetCookie = res.headers['set-cookie']
    const verifierCookieStr = Array.isArray(verifierSetCookie) ? verifierSetCookie.join('; ') : verifierSetCookie
    expect(verifierCookieStr).toContain('verifier-auth.session_token=')
  })

  it('get-session no verifier com cookie do admin retorna null (isolamento)', async () => {
    const adminCookieStr = Array.isArray(adminSetCookie) ? adminSetCookie.join('; ') : adminSetCookie
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/verifier/get-session',
      headers: {
        cookie: adminCookieStr,
      },
    })
    console.log('verifier get-session com cookie admin:', res.statusCode, res.body)

    expect(res.statusCode).toBe(200)
    // Quando não há sessão, better-auth retorna body vazio/undefined
    const body = res.body ? JSON.parse(res.body as string) : null
    // user deve ser null/undefined (não há sessão do verifier com cookie do admin)
    expect(body?.user).toBeFalsy()

    // Não deve emitir Set-Cookie expirando admin-auth.*
    const respSetCookie = res.headers['set-cookie']
    const respCookieStr = Array.isArray(respSetCookie) ? respSetCookie.join('; ') : respSetCookie
    if (respCookieStr) {
      const expiredAdminAuth = respCookieStr.includes('admin-auth.session_token=') && respCookieStr.includes('Max-Age=0')
      expect(expiredAdminAuth).toBe(false)
    }
  })

  it('get-session no admin com cookie do admin retorna o usuário', async () => {
    const adminCookieStr = Array.isArray(adminSetCookie) ? adminSetCookie.join('; ') : adminSetCookie
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/admin/get-session',
      headers: {
        cookie: adminCookieStr,
      },
    })
    console.log('admin get-session com cookie admin:', res.statusCode, res.body)

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.user).not.toBeNull()
    expect(body.user.email).toBe(ADMIN_EMAIL)
  })
})
