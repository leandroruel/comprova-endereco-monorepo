import { afterAll, describe, expect, it } from 'vitest'
import { startTestDb, startTestRedis } from '@comprova/testing'
import { runMigrations, createDbPool, sql } from '@comprova/db'
import Redis from 'ioredis'
import { createLogger, createMetrics } from '@comprova/observability'
import { buildApp } from '../src/app.js'

const PEPPER = 'test-pepper-123'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: 'test-password' })
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

const INVALID_EMAIL = 'nao-existe@exemplo.com'
const INVALID_PASSWORD = 'senha-errada'

describe('auth sign-in via proxy (reproduz 404 com header Origin)', () => {
  it('admin sign-in com header Origin → não retorna 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/admin/sign-in/email',
      body: { email: INVALID_EMAIL, password: INVALID_PASSWORD },
      headers: {
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      },
    })
    console.log('admin sign-in com Origin:', res.statusCode, res.body)
    // O ponto crítico: nunca deve ser 404 (bug do Origin com protocolo)
    expect(res.statusCode).not.toBe(404)
  })

  it('admin sign-in SEM header Origin → não retorna 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/admin/sign-in/email',
      body: { email: INVALID_EMAIL, password: INVALID_PASSWORD },
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      },
    })
    console.log('admin sign-in sem Origin:', res.statusCode, res.body)
    expect(res.statusCode).not.toBe(404)
  })

  it('verifier sign-in com header Origin → não retorna 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verifier/sign-in/email',
      body: { email: INVALID_EMAIL, password: INVALID_PASSWORD },
      headers: {
        origin: 'http://localhost:5174',
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      },
    })
    console.log('verifier sign-in com Origin:', res.statusCode, res.body)
    expect(res.statusCode).not.toBe(404)
  })

  it('verifier sign-in SEM header Origin → não retorna 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verifier/sign-in/email',
      body: { email: INVALID_EMAIL, password: INVALID_PASSWORD },
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      },
    })
    console.log('verifier sign-in sem Origin:', res.statusCode, res.body)
    expect(res.statusCode).not.toBe(404)
  })
})
