import { createDbPool, runMigrations } from '@comprova/db'
import { createLogger, createMetrics } from '@comprova/observability'
import { startTestDb, startTestRedis, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

const PEPPER = 'test-pepper-123'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

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

let orgTenantId: string
let ownerSessionCookie: string
let memberSessionCookie: string

/** Faz sign-up via Better Auth e retorna o id do usuário criado. */
const signUp = async (email: string, password: string, name: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  })
  expect(res.statusCode).toBe(200)
  const user = res.json() as { user?: { id: string } }
  expect(user.user).toBeDefined()
  return user.user!.id
}

/** Faz login via Better Auth e retorna o cookie de sessão. */
const loginAndGetCookie = async (email: string, password: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  expect(res.statusCode).toBe(200)
  const setCookie = res.headers['set-cookie']
  if (!setCookie) throw new Error('No set-cookie header')
  const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie
  const match = cookieHeader.match(/better-auth\.session_token=([^;]+)/)
  const token = match?.[1]
  if (!token) throw new Error('Session token not found in cookie')
  return token
}

/** Faz uma requisição com cookie de sessão. */
const injectWithSession = async (
  method: string,
  url: string,
  body?: unknown,
  sessionCookie: string = ownerSessionCookie,
) => {
  return app.inject({
    method,
    url,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `better-auth.session_token=${sessionCookie}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

beforeAll(async () => {
  // Cadastra usuários via Better Auth
  await signUp('owner@exemplo.com', 'SenhaForte123!', 'Dono da Organização')
  await signUp('member@exemplo.com', 'SenhaForte123!', 'Membro da Organização')
  await signUp('invitee@exemplo.com', 'SenhaForte123!', 'Convidado do Convite')
  await signUp('outro@exemplo.com', 'SenhaForte123!', 'Outro Usuário')

  // Faz login para obter cookies de sessão
  ownerSessionCookie = await loginAndGetCookie('owner@exemplo.com', 'SenhaForte123!')
  memberSessionCookie = await loginAndGetCookie('member@exemplo.com', 'SenhaForte123!')

  // Cria uma organização via API (simulando onboarding)
  const createRes = await injectWithSession('POST', '/v1/organizations', {
    name: 'Organização Teste',
    email: 'owner@exemplo.com',
    termsVersion: '1.0.0',
  })
  expect(createRes.statusCode).toBe(201)
  const org = createRes.json()
  orgTenantId = org.tenantId
})

afterAll(async () => {
  await app.close()
  redis.disconnect()
  await adminPool.end()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

describe('Verifier Onboarding', () => {
  it('deve criar uma organização e associar o usuário como owner', async () => {
    const res = await injectWithSession('POST', '/v1/organizations', {
      name: 'Nova Organização',
      termsVersion: '1.0.0',
    })
    expect(res.statusCode).toBe(201)
    const org = res.json()
    expect(org.name).toBe('Nova Organização')
    expect(org.onboardingStatus).toBe('pending')
    // A versão dos termos é definida exclusivamente pelo servidor.
    expect(org.termsVersion).toBe('1.0.0')
    expect(org.type).toBe('organization')
  })

  it('deve listar organizações do usuário', async () => {
    const res = await injectWithSession('GET', '/v1/organizations', undefined, ownerSessionCookie)
    expect(res.statusCode).toBe(200)
    const orgs = res.json()
    expect(Array.isArray(orgs)).toBe(true)
    expect(orgs.length).toBeGreaterThan(0)
  })

  it('deve buscar uma organização à qual o usuário pertence', async () => {
    const res = await injectWithSession(
      'GET',
      `/v1/organizations/${orgTenantId}`,
      undefined,
      ownerSessionCookie,
    )
    expect(res.statusCode).toBe(200)
    const org = res.json()
    expect(org.tenantId).toBe(orgTenantId)
  })

  it('deve impedir acesso a organização de outro usuário', async () => {
    const res = await injectWithSession(
      'GET',
      `/v1/organizations/${orgTenantId}`,
      undefined,
      memberSessionCookie,
    )
    expect(res.statusCode).toBe(403)
  })

  it('deve completar o onboarding aceitando termos', async () => {
    const res = await injectWithSession(
      'POST',
      `/v1/organizations/${orgTenantId}/onboarding/complete`,
      { termsVersion: '1.0.0' },
      ownerSessionCookie,
    )
    expect(res.statusCode).toBe(200)
    const org = res.json()
    expect(org.onboardingStatus).toBe('completed')
    expect(org.termsAcceptedAt).not.toBeNull()
  })

  it('não deve permitir que não-owner complete o onboarding', async () => {
    // Cria organização com o owner
    const createRes = await injectWithSession(
      'POST',
      '/v1/organizations',
      {
        name: 'Org Onboarding Não-Owner',
        email: 'owner@exemplo.com',
        termsVersion: '1.0.0',
      },
      ownerSessionCookie,
    )
    expect(createRes.statusCode).toBe(201)
    const tenantId = createRes.json().tenantId

    // Owner adiciona o member como membro simples
    const addRes = await injectWithSession(
      'POST',
      `/v1/organizations/${tenantId}/members`,
      { email: 'member@exemplo.com', role: 'member' },
      ownerSessionCookie,
    )
    expect(addRes.statusCode).toBe(201)

    // O membro tenta completar o onboarding (não é owner) → 403
    const res = await injectWithSession(
      'POST',
      `/v1/organizations/${tenantId}/onboarding/complete`,
      { termsVersion: '1.0.0' },
      memberSessionCookie,
    )
    expect(res.statusCode).toBe(403)
  })

  it('deve adicionar e listar membros', async () => {
    const createRes = await injectWithSession('POST', '/v1/organizations', {
      name: 'Org Membros',
      email: 'owner@exemplo.com',
      termsVersion: '1.0.0',
    })
    expect(createRes.statusCode).toBe(201)
    const memberOrgTenantId = createRes.json().tenantId

    // Owner adiciona membro
    const addRes = await injectWithSession(
      'POST',
      `/v1/organizations/${memberOrgTenantId}/members`,
      { email: 'member@exemplo.com', role: 'member' },
      ownerSessionCookie,
    )
    expect(addRes.statusCode).toBe(201)

    // Lista membros
    const listRes = await injectWithSession(
      'GET',
      `/v1/organizations/${memberOrgTenantId}/members`,
      undefined,
      ownerSessionCookie,
    )
    expect(listRes.statusCode).toBe(200)
    const members = listRes.json()
    expect(members.length).toBeGreaterThanOrEqual(1)
    expect((members as Array<{ userEmail: string }>).some((m) => m.userEmail === 'member@exemplo.com')).toBe(
      true,
    )
  })

  it('não deve permitir que não-admin adicione membros', async () => {
    // Adiciona o member como membro de orgTenantId para passar no guard de membership
    const addMemberRes = await injectWithSession(
      'POST',
      `/v1/organizations/${orgTenantId}/members`,
      { email: 'member@exemplo.com', role: 'member' },
      ownerSessionCookie,
    )
    expect(addMemberRes.statusCode).toBe(201)

    const res = await injectWithSession(
      'POST',
      `/v1/organizations/${orgTenantId}/members`,
      { email: 'outro@exemplo.com', role: 'member' },
      memberSessionCookie,
    )
    expect(res.statusCode).toBe(403)
  })
})

describe('Verifier M2M Integration', () => {
  it('deve criar uma credencial M2M e retornar o segredo apenas na criação', async () => {
    const res = await injectWithSession(
      'POST',
      `/v1/m2m/api-keys`,
      {
        tenantId: orgTenantId,
        name: 'Chave M2M Teste',
        scopes: ['validate:read', 'validate:write', 'verify:m2m'],
        keyType: 'm2m',
      },
      ownerSessionCookie,
    )
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.apiKey.keyPrefix).toBeDefined()
    expect(body.secret).toBeDefined()
    expect(body.secret.length).toBeGreaterThan(0)
    expect(body.apiKey.key).toBeUndefined() // segredo não está no objeto da chave
    expect(body.apiKey.keyType).toBe('m2m')
    expect(body.apiKey.tenantId).toBe(orgTenantId)
    expect(body.apiKey.revokedAt).toBeNull()
  })

  it('deve listar credenciais sem expor o segredo', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/m2m/api-keys?tenantId=${orgTenantId}`,
      headers: {
        Cookie: `better-auth.session_token=${ownerSessionCookie}`,
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.apiKeys)).toBe(true)
    for (const key of body.apiKeys) {
      expect(key.key).toBeUndefined() // nunca expõe o segredo
      expect(key.keyPrefix).toBeDefined()
    }
  })

  it('deve revogar uma credencial M2M', async () => {
    const createRes = await injectWithSession(
      'POST',
      `/v1/m2m/api-keys`,
      { tenantId: orgTenantId, name: 'Chave para Revogar', keyType: 'm2m' },
      ownerSessionCookie,
    )
    expect(createRes.statusCode).toBe(201)
    const keyId = createRes.json().apiKey.apiKeyId

    const revokeRes = await injectWithSession(
      'DELETE',
      `/v1/m2m/api-keys/${keyId}`,
      { tenantId: orgTenantId },
      ownerSessionCookie,
    )
    expect(revokeRes.statusCode).toBe(200)
    expect(revokeRes.json().revoked).toBe(true)

    // Tenta revogar novamente (já revogada)
    const revokeAgain = await injectWithSession(
      'DELETE',
      `/v1/m2m/api-keys/${keyId}`,
      { tenantId: orgTenantId },
      ownerSessionCookie,
    )
    expect(revokeAgain.statusCode).toBe(404)
  })

  it('não deve permitir acesso a credenciais inexistentes', async () => {
    const res = await injectWithSession(
      'DELETE',
      '/v1/m2m/api-keys/00000000-0000-4000-8000-000000000000',
      { tenantId: orgTenantId },
      ownerSessionCookie,
    )
    expect(res.statusCode).toBe(404)
  })
})

describe('Verifier Convites e aceitação', () => {
  let inviteeSessionCookie: string

  beforeAll(async () => {
    inviteeSessionCookie = await loginAndGetCookie('invitee@exemplo.com', 'SenhaForte123!')
  })

  it('deve criar um convite e devolver o token apenas uma vez', async () => {
    const createRes = await injectWithSession(
      'POST',
      `/v1/organizations/${orgTenantId}/invitations`,
      { email: 'invitee@exemplo.com', role: 'member' },
      ownerSessionCookie,
    )
    expect(createRes.statusCode).toBe(201)
    const body = createRes.json()
    expect(body.token).toBeDefined()
    expect(typeof body.token).toBe('string')
    expect(body.email).toBe('invitee@exemplo.com')
    expect(body.role).toBe('member')
  })

  it('não permite que admin crie convite com role owner', async () => {
    const createRes = await injectWithSession('POST', '/v1/organizations', {
      name: 'Org Admin Convite',
      email: 'owner@exemplo.com',
      termsVersion: '1.0.0',
    })
    expect(createRes.statusCode).toBe(201)
    const adminOrgId = createRes.json().tenantId

    // O owner promove o member a admin.
    const promoteRes = await injectWithSession(
      'POST',
      `/v1/organizations/${adminOrgId}/members`,
      { email: 'member@exemplo.com', role: 'admin' },
      ownerSessionCookie,
    )
    expect(promoteRes.statusCode).toBe(201)

    // O admin tenta convidar outro como owner → deve ser rejeitado.
    const res = await injectWithSession(
      'POST',
      `/v1/organizations/${adminOrgId}/invitations`,
      { email: 'outro@exemplo.com', role: 'owner' },
      memberSessionCookie,
    )
    expect(res.statusCode).toBe(403)
  })

  it('não permite que admin adicione membro com role owner', async () => {
    const createRes = await injectWithSession('POST', '/v1/organizations', {
      name: 'Org Admin Membro',
      email: 'owner@exemplo.com',
      termsVersion: '1.0.0',
    })
    expect(createRes.statusCode).toBe(201)
    const adminOrgId = createRes.json().tenantId

    await injectWithSession(
      'POST',
      `/v1/organizations/${adminOrgId}/members`,
      { email: 'member@exemplo.com', role: 'admin' },
      ownerSessionCookie,
    )

    const res = await injectWithSession(
      'POST',
      `/v1/organizations/${adminOrgId}/members`,
      { email: 'outro@exemplo.com', role: 'owner' },
      memberSessionCookie,
    )
    expect(res.statusCode).toBe(403)
  })

  it('owner consegue adicionar membro e admin (papéis permitidos)', async () => {
    const createRes = await injectWithSession('POST', '/v1/organizations', {
      name: 'Org Owner Ops',
      email: 'owner@exemplo.com',
      termsVersion: '1.0.0',
    })
    expect(createRes.statusCode).toBe(201)
    const orgId = createRes.json().tenantId

    const m = await injectWithSession(
      'POST',
      `/v1/organizations/${orgId}/members`,
      { email: 'member@exemplo.com', role: 'member' },
      ownerSessionCookie,
    )
    expect(m.statusCode).toBe(201)

    const a = await injectWithSession(
      'POST',
      `/v1/organizations/${orgId}/members`,
      { email: 'outro@exemplo.com', role: 'admin' },
      ownerSessionCookie,
    )
    expect(a.statusCode).toBe(201)
  })

  it('não permite criar um segundo proprietário (modelo de owner único)', async () => {
    const createRes = await injectWithSession('POST', '/v1/organizations', {
      name: 'Org Single Owner',
      email: 'owner@exemplo.com',
      termsVersion: '1.0.0',
    })
    expect(createRes.statusCode).toBe(201)
    const orgId = createRes.json().tenantId

    const res = await injectWithSession(
      'POST',
      `/v1/organizations/${orgId}/members`,
      { email: 'outro@exemplo.com', role: 'owner' },
      ownerSessionCookie,
    )
    expect(res.statusCode).toBe(403)
  })

  it('destinatário correto consegue aceitar o convite', async () => {
    const createRes = await injectWithSession('POST', '/v1/organizations', {
      name: 'Org Convite Aceito',
      email: 'owner@exemplo.com',
      termsVersion: '1.0.0',
    })
    expect(createRes.statusCode).toBe(201)
    const orgId = createRes.json().tenantId

    const inviteRes = await injectWithSession(
      'POST',
      `/v1/organizations/${orgId}/invitations`,
      { email: 'invitee@exemplo.com', role: 'member' },
      ownerSessionCookie,
    )
    expect(inviteRes.statusCode).toBe(201)
    const token = inviteRes.json().token

    const res = await injectWithSession(
      'POST',
      '/v1/organizations/invitations/accept',
      { token },
      inviteeSessionCookie,
    )
    expect(res.statusCode).toBe(200)
    const member = res.json()
    expect(member.userEmail).toBe('invitee@exemplo.com')
    expect(member.role).toBe('member')
    expect(member.userName).toBe('Convidado do Convite')
  })

  it('outra conta não consegue aceitar convite endereçado a outro destinatário', async () => {
    const createRes = await injectWithSession('POST', '/v1/organizations', {
      name: 'Org Convite Outro',
      email: 'owner@exemplo.com',
      termsVersion: '1.0.0',
    })
    expect(createRes.statusCode).toBe(201)
    const orgId = createRes.json().tenantId

    const inviteRes = await injectWithSession(
      'POST',
      `/v1/organizations/${orgId}/invitations`,
      { email: 'invitee@exemplo.com', role: 'member' },
      ownerSessionCookie,
    )
    expect(inviteRes.statusCode).toBe(201)
    const token = inviteRes.json().token

    const otherCookie = await loginAndGetCookie('outro@exemplo.com', 'SenhaForte123!')
    const res = await injectWithSession(
      'POST',
      '/v1/organizations/invitations/accept',
      { token },
      otherCookie,
    )
    // O RLS oculta o convite de quem não é o destinatário (não vazia existência).
    expect(res.statusCode).toBe(404)
  })

  it('convite já utilizado é rejeitado na segunda aceitação', async () => {
    const createRes = await injectWithSession('POST', '/v1/organizations', {
      name: 'Org Convite Usado',
      email: 'owner@exemplo.com',
      termsVersion: '1.0.0',
    })
    expect(createRes.statusCode).toBe(201)
    const orgId = createRes.json().tenantId

    const inviteRes = await injectWithSession(
      'POST',
      `/v1/organizations/${orgId}/invitations`,
      { email: 'invitee@exemplo.com', role: 'member' },
      ownerSessionCookie,
    )
    expect(inviteRes.statusCode).toBe(201)
    const token = inviteRes.json().token

    const first = await injectWithSession(
      'POST',
      '/v1/organizations/invitations/accept',
      { token },
      inviteeSessionCookie,
    )
    expect(first.statusCode).toBe(200)

    const second = await injectWithSession(
      'POST',
      '/v1/organizations/invitations/accept',
      { token },
      inviteeSessionCookie,
    )
    expect(second.statusCode).toBe(404)
  })

  it('duas tentativas concorrentes não consomem o mesmo convite duas vezes', async () => {
    const createRes = await injectWithSession('POST', '/v1/organizations', {
      name: 'Org Convite Concorrente',
      email: 'owner@exemplo.com',
      termsVersion: '1.0.0',
    })
    expect(createRes.statusCode).toBe(201)
    const orgId = createRes.json().tenantId

    const inviteRes = await injectWithSession(
      'POST',
      `/v1/organizations/${orgId}/invitations`,
      { email: 'invitee@exemplo.com', role: 'member' },
      ownerSessionCookie,
    )
    expect(inviteRes.statusCode).toBe(201)
    const token = inviteRes.json().token

    const results = await Promise.all([
      injectWithSession('POST', '/v1/organizations/invitations/accept', { token }, inviteeSessionCookie),
      injectWithSession('POST', '/v1/organizations/invitations/accept', { token }, inviteeSessionCookie),
    ])
    const statuses = results.map((r) => r.statusCode).sort()
    expect(statuses).toEqual([200, 404])
  })

  it('não permite que não-admin crie convite', async () => {
    const res = await injectWithSession(
      'POST',
      `/v1/organizations/${orgTenantId}/invitations`,
      { email: 'outro@exemplo.com', role: 'member' },
      inviteeSessionCookie,
    )
    expect(res.statusCode).toBe(403)
  })
})

describe('Verifier Isolamento (RLS)', () => {
  let orgBTenantId: string

  beforeAll(async () => {
    const createRes = await injectWithSession('POST', '/v1/organizations', {
      name: 'Organização B',
      email: 'owner@exemplo.com',
      termsVersion: '1.0.0',
    })
    expect(createRes.statusCode).toBe(201)
    orgBTenantId = createRes.json().tenantId
  })

  it('usuário de outra organização não consegue consultar membros da orgB', async () => {
    const memberCookie = await loginAndGetCookie('member@exemplo.com', 'SenhaForte123!')
    const res = await injectWithSession(
      'GET',
      `/v1/organizations/${orgBTenantId}/members`,
      undefined,
      memberCookie,
    )
    expect(res.statusCode).toBe(403)
  })

  it('usuário de outra organização não consegue adicionar membros na orgB', async () => {
    const memberCookie = await loginAndGetCookie('member@exemplo.com', 'SenhaForte123!')
    const res = await injectWithSession(
      'POST',
      `/v1/organizations/${orgBTenantId}/members`,
      { email: 'outro@exemplo.com', role: 'member' },
      memberCookie,
    )
    expect(res.statusCode).toBe(403)
  })

  it('convite não pode ser aceito por quem não é o destinatário (isolamento de convite)', async () => {
    const inviteRes = await injectWithSession(
      'POST',
      `/v1/organizations/${orgBTenantId}/invitations`,
      { email: 'invitee@exemplo.com', role: 'member' },
      ownerSessionCookie,
    )
    expect(inviteRes.statusCode).toBe(201)
    const token = inviteRes.json().token

    // O member da organização A não é o destinatário do convite da orgB.
    const memberCookie = await loginAndGetCookie('member@exemplo.com', 'SenhaForte123!')
    const res = await injectWithSession(
      'POST',
      '/v1/organizations/invitations/accept',
      { token },
      memberCookie,
    )
    expect(res.statusCode).toBe(404)
  })
})
