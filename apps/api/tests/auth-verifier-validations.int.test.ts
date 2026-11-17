import { afterAll, describe, expect, it } from 'vitest'
import {
  createTenant,
  createSubject,
  createValidation,
  startTestDb,
  startTestRedis,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import { runMigrations, createDbPool, sql, eq } from '@comprova/db'
import Redis from 'ioredis'
import { createLogger, createMetrics } from '@comprova/observability'
import { buildApp } from '../src/app.js'
import * as t from '@comprova/db'

const PEPPER = 'test-pepper-123'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

// Criar tabelas do better-auth verifier (não cobertas pelas migrations do projeto)
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

// Garante que o app_user enxerga as tabelas criadas pelo superuser
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

// Cria dois tenants (organizações) distintas
const tenantA = await createTenant(adminPool.db, { name: 'org-verifier-a' })
const tenantB = await createTenant(adminPool.db, { name: 'org-verifier-b' })

// Cria um subject e validação em cada tenant
const subjectA = await createSubject(adminPool.db, tenantA, 'CNPJ')
const subjectB = await createSubject(adminPool.db, tenantB, 'CNPJ')

const validationA = await createValidation(adminPool.db, tenantA, subjectA, {
  verdict: 'RESIDENTIAL',
  explanationSummary: 'Endereço parece residencial.',
})
const validationB = await createValidation(adminPool.db, tenantB, subjectB, {
  verdict: 'RESIDENTIAL',
  explanationSummary: 'Endereço da org B.',
})

// Cria um usuário no verifier
const VERIFIER_PASSWORD = 'SenhaForte123!'
const verifierEmail = `verifier-${Date.now()}@exemplo.com`

await app.inject({
  method: 'POST',
  url: '/v1/auth/verifier/sign-up/email',
  body: { email: verifierEmail, password: VERIFIER_PASSWORD, name: 'Verifier Teste' },
})
await app.inject({
  method: 'POST',
  url: '/v1/auth/verifier/sign-in/email',
  body: { email: verifierEmail, password: VERIFIER_PASSWORD },
})

// Obtém cookie de sessão
const signIn = await app.inject({
  method: 'POST',
  url: '/v1/auth/verifier/sign-in/email',
  body: { email: verifierEmail, password: VERIFIER_PASSWORD },
})

const setCookie = signIn.headers['set-cookie']
const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie ?? '')

// Resolve o id real do usuário criado pelo better-auth
const userRow = await adminPool.db
  .select({ id: t.verifierAuthUser.id })
  .from(t.verifierAuthUser)
  .where(eq(t.verifierAuthUser.email, verifierEmail))
  .limit(1)

const userId = userRow[0]?.id
if (!userId) {
  throw new Error('não foi possível resolver o id do usuário verifier')
}

// Vincula o usuário à organização A como owner
await adminPool.db.insert(t.organizationMember).values({
  organizationMemberId: crypto.randomUUID(),
  tenantId: tenantA,
  userId,
  role: 'owner',
})

// Helper de requisição com sessão do Verifier
const injectVerifier = (
  method = 'GET',
  url = '/',
  body?: unknown,
  extraHeaders: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieStr,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...extraHeaders,
    },
  })

describe('autenticação Verifier Dashboard - validações', () => {
  describe('cenários de sucesso (sessão válida + vínculo com organização)', () => {
    it('cenário 1: sessão válida com Origin do verifier lista validações da própria organização', async () => {
      const res = await injectVerifier('GET', `/v1/validations?tenantId=${tenantA}`, undefined, {
        origin: 'http://verifier.localhost:5174',
      })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(Array.isArray(body.validations)).toBe(true)
      expect(body.validations.some((v: { validation_id: string }) => v.validation_id === validationA)).toBe(
        true,
      )
    })

    it('cenário 2: sessão válida consulta detalhe de validação da própria organização', async () => {
      const res = await injectVerifier(
        'GET',
        `/v1/validations/${validationA}?tenantId=${tenantA}`,
        undefined,
        {
          origin: 'http://verifier.localhost:5174',
        },
      )
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.validation_id).toBe(validationA)
      expect(body.verdict).toBe('RESIDENTIAL')
    })
  })

  describe('cenários de falha de autenticação/autorização', () => {
    it('cenário 3: sessão ausente não acessa listagem nem detalhe', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: `/v1/validations?tenantId=${tenantA}`,
      })
      expect(listRes.statusCode).toBe(401)

      const detailRes = await app.inject({
        method: 'GET',
        url: `/v1/validations/${validationA}?tenantId=${tenantA}`,
      })
      expect(detailRes.statusCode).toBe(401)
    })

    it('cenário 4: usuário autenticado sem vínculo com a organização solicitada não acessa', async () => {
      // O usuário é membro apenas do tenant A. Tentar acessar tenant B deve retornar 403.
      const listRes = await injectVerifier('GET', `/v1/validations?tenantId=${tenantB}`, undefined, {
        origin: 'http://verifier.localhost:5174',
      })
      expect(listRes.statusCode).toBe(403)

      const detailRes = await injectVerifier(
        'GET',
        `/v1/validations/${validationB}?tenantId=${tenantB}`,
        undefined,
        {
          origin: 'http://verifier.localhost:5174',
        },
      )
      expect(detailRes.statusCode).toBe(403)
    })

    it('cenário 5: consulta de validação de outra organização não retorna seus dados', async () => {
      const listRes = await injectVerifier('GET', `/v1/validations?tenantId=${tenantB}`, undefined, {
        origin: 'http://verifier.localhost:5174',
      })
      expect(listRes.statusCode).toBe(403)

      const body = listRes.json() as { validations?: unknown[] }
      expect(body.validations).toBeUndefined()
    })

    it('cenário 6: Origin ausente não resolve sessão (sem fallback) → 401', async () => {
      // Sem Origin/Referer: sem fallback, nenhuma sessão é resolvida.
      const res = await injectVerifier('GET', `/v1/validations?tenantId=${tenantA}`)
      expect(res.statusCode).toBe(401)
    })

    it('cenário 6b: Origin não permitido não resolve sessão → 401', async () => {
      const res = await injectVerifier('GET', `/v1/validations?tenantId=${tenantA}`, undefined, {
        origin: 'http://malicious.example.com',
      })
      expect(res.statusCode).toBe(401)
    })
  })
})
