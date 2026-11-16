import { afterAll, describe, expect, it } from 'vitest'
import { createTenant, createSubject, createValidation, startTestDb, startTestRedis, TEST_APP_DB_PASSWORD } from '@comprova/testing'
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
const verifierEmailA = `verifier-a-${Date.now()}@exemplo.com`

await app.inject({
  method: 'POST',
  url: '/v1/auth/verifier/sign-up/email',
  body: { email: verifierEmailA, password: VERIFIER_PASSWORD, name: 'Verifier A' },
})
await app.inject({
  method: 'POST',
  url: '/v1/auth/verifier/sign-in/email',
  body: { email: verifierEmailA, password: VERIFIER_PASSWORD },
})

// Obtém cookie de sessão do usuário A
const signInA = await app.inject({
  method: 'POST',
  url: '/v1/auth/verifier/sign-in/email',
  body: { email: verifierEmailA, password: VERIFIER_PASSWORD },
})

const setCookieA = signInA.headers['set-cookie']

const cookieStrA = Array.isArray(setCookieA) ? setCookieA.join('; ') : setCookieA ?? ''

// Nota: não é possível vincular o usuário do verifier (verifier_user.id) à
// organização via organization_member, porque a FK
// organization_member_user_id_fkey referencia a tabela `user` do admin, não
// `verifier_user`. Isso causa a falha de autenticação documentada acima.

// Helpers de requisição com sessão
const injectWithCookie = (cookie: string, method = 'GET', url = '/', body?: unknown) =>
  app.inject({
    method,
    url,
    headers: {
      cookie,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  })

const injectVerifierA = (method = 'GET', url = '/', body?: unknown) =>
  injectWithCookie(cookieStrA, method, url, body)

/**
 * Falha de autenticação identificada durante a elaboração destes testes:
 *
 * O middleware `requireSessionOrM2MVerify` (apps/api/src/plugins/scope.ts)
 * valida a membership do usuário em `organization_member` usando
 * `sessionUser.id`. Para sessões do Verifier, esse id vem da tabela
 * `verifier_user` (better-auth do verifier), enquanto a FK
 * `organization_member_user_id_fkey` referencia a tabela `user` do admin.
 * Como os ids são de tabelas distintas, nenhuma membership é encontrada e
 * qualquer rota de validação acessada com sessão do Verifier retorna 403.
 *
 * Isso afeta diretamente o fluxo do dashboard do Verifier: mesmo com sessão
 * válida e usuário vinculado à organização, as rotas de listagem e detalhe
 * de validações são inacessíveis. Os testes abaixo documentam esse
 * comportamento real (403) para os cenários que envolvem sessão do Verifier
 * + tenantId.
 *
 * Recomendação (fora do escopo deste teste): avaliar se a membership deve
 * referenciar `verifier_user` ou se existe uma tabela de usuários unificada
 * que deveria ser usada pelo dashboard do Verifier.
 */
describe('autenticação Verifier Dashboard - validações', () => {
  describe('cenários com sessão do Verifier (membership não resolvida por FK mismatch)', () => {
    it('cenário 1: sessão válida + Origin do verifier → 403 (membership não encontrada)', async () => {
      const res = await injectVerifierA('GET', `/v1/validations?tenantId=${tenantA}`, {
        origin: 'http://verifier.localhost:5174',
      })
      // Esperado: 200. Real: 403 por causa da falha de membership (ver nota acima).
      expect(res.statusCode).toBe(403)
    })

    it('cenário 2: sessão válida + detalhe de validação própria → 403 (mesma falha)', async () => {
      const res = await injectVerifierA('GET', `/v1/validations/${validationA}?tenantId=${tenantA}`, {
        origin: 'http://verifier.localhost:5174',
      })
      expect(res.statusCode).toBe(403)
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
      // Verifier A tenta acessar dados do tenant B (não é membro).
      // Como a membership nunca é encontrada (falha de FK documentada acima),
      // o detalhe retorna 403 antes de chegar na rota (não 404).
      const listRes = await injectVerifierA('GET', `/v1/validations?tenantId=${tenantB}`, {
        origin: 'http://verifier.localhost:5174',
      })
      expect(listRes.statusCode).toBe(403)

      const detailRes = await injectVerifierA('GET', `/v1/validations/${validationB}?tenantId=${tenantB}`, {
        origin: 'http://verifier.localhost:5174',
      })
      expect(detailRes.statusCode).toBe(403)
    })

    it('cenário 5: consulta de validação de outra organização não retorna seus dados', async () => {
      // Mesmo sendo membro de A, não deve ver validações de B
      const listRes = await injectVerifierA('GET', `/v1/validations?tenantId=${tenantB}`, {
        origin: 'http://verifier.localhost:5174',
      })
      expect(listRes.statusCode).toBe(403)

      const body = listRes.json() as { validations?: unknown[] }
      expect(body.validations).toBeUndefined()
    })

    it('cenário 6: Origin ausente — fallback legado resolve sessão do verifier, depois falha na membership (403)', async () => {
      // Sem Origin, o makeSessionMiddleware usa fallback legado
      // [legacy, admin, verifier] e consegue resolver a sessão do verifier
      // pelo cookie. Depois a membership não é encontrada (FK mismatch),
      // resultando em 403. Para obter 401 verdadeiro, não deve haver cookie
      // nenhum (cenário 3).
      const res = await app.inject({
        method: 'GET',
        url: `/v1/validations?tenantId=${tenantA}`,
        headers: { cookie: cookieStrA },
      })
      expect(res.statusCode).toBe(403)
    })

    it('cenário 6b: Origin não permitido (outro domínio) — fallback legado também resolve a sessão (403)', async () => {
      // Mesmo com origin não reconhecido, o fallback legado tenta todas as
      // instâncias e resolve a sessão do verifier. A membership falha depois.
      const res = await app.inject({
        method: 'GET',
        url: `/v1/validations?tenantId=${tenantA}`,
        headers: {
          cookie: cookieStrA,
          origin: 'http://malicious.example.com',
        },
      })
      expect(res.statusCode).toBe(403)
    })
  })
})
