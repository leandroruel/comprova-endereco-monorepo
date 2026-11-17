import { afterAll, describe, expect, it } from 'vitest'
import { createTenant, startTestDb, startTestRedis, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import { runMigrations, createDbPool, sql } from '@comprova/db'
import Redis from 'ioredis'
import { randomUUID } from 'node:crypto'
import { createLogger, createMetrics } from '@comprova/observability'
import { buildApp } from '../src/app.js'
import * as t from '@comprova/db'
import { makeOrganizationsService } from '../src/modules/organizations/organizations.service.js'

const PEPPER = 'test-pepper-123'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

// Criar tabelas do better-auth verifier
await adminPool.db.execute(sql`
  CREATE TABLE IF NOT EXISTS verifier_user (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE, image TEXT,
    role TEXT NOT NULL DEFAULT 'user', banned BOOLEAN NOT NULL DEFAULT FALSE,
    ban_reason TEXT, ban_expires TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )
`)
await adminPool.db.execute(sql`
  CREATE TABLE IF NOT EXISTS verifier_session (
    id TEXT PRIMARY KEY, expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    token TEXT NOT NULL UNIQUE, created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    ip_address TEXT, user_agent TEXT,
    user_id TEXT NOT NULL REFERENCES verifier_user(id),
    impersonated_by TEXT
  )
`)
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

// Cria usuário verifier diretamente na tabela
const verifierId = randomUUID()
const verifierEmail = `verifier-org-${Date.now()}@exemplo.com`
await adminPool.db.insert(t.verifierAuthUser).values({
  id: verifierId,
  name: 'Verifier Org',
  email: verifierEmail,
  role: 'user',
})

// Cria dois tenants
const tenantA = await createTenant(adminPool.db, { name: 'org-verifier-a' })
const tenantB = await createTenant(adminPool.db, { name: 'org-verifier-b' })

// Vincula o usuário à organização A como owner
await adminPool.db.insert(t.organizationMember).values({
  organizationMemberId: randomUUID(),
  tenantId: tenantA,
  userId: verifierId,
  role: 'owner',
})

// Instancia o serviço de organizações
const orgService = makeOrganizationsService({
  db: appPool.db,
  termsVersion: '1.0.0',
  termsApproved: true,
  termsDocumentHash: 'sha256:abc123def456',
})

describe('autenticação Verifier Dashboard - organizações (serviço direto)', () => {
  describe('cenários de sucesso', () => {
    it('cenário 1: Verifier consegue criar uma organização', async () => {
      const org = await orgService.createOrganization(
        {
          name: 'Minha Organização',
          legalName: 'Minha Organização LTDA',
          document: '00.000.000/0001-00',
          termsVersion: '1.0.0',
          dataRegion: 'sa-east-1',
        },
        verifierId,
      )
      expect(org.tenantId).toBeDefined()
      expect(org.name).toBe('Minha Organização')
      expect(org.role).toBe('owner')
    })

    it('cenário 2: Verifier consegue listar suas organizações', async () => {
      const orgs = await orgService.listOrganizationsByUser(verifierId)
      expect(orgs.length).toBeGreaterThanOrEqual(1)
      expect(orgs.some((o) => o.tenantId === tenantA && o.role === 'owner')).toBe(true)
    })

    it('cenário 3: Verifier consegue acessar sua própria organização', async () => {
      // Criar organização e verificar acesso direto
      const created = await orgService.createOrganization(
        {
          name: 'Org de Teste',
          legalName: 'Org de Teste LTDA',
          document: '00.000.000/0001-00',
          termsVersion: '1.0.0',
          dataRegion: 'sa-east-1',
        },
        verifierId,
      )
      expect(created.tenantId).toBeDefined()
      expect(created.role).toBe('owner')
      // Verificar via listagem (que usa com tenantId definido)
      const orgs = await orgService.listOrganizationsByUser(verifierId)
      expect(orgs.some((o) => o.tenantId === created.tenantId && o.role === 'owner')).toBe(true)
    })

    it('cenário 4: usuário sem membership na organização recebe null', async () => {
      const org = await orgService.getOrganization(tenantB, verifierId)
      expect(org).toBeNull()
    })

    it('cenário 5: listar membros da organização', async () => {
      const members = await orgService.listMembers(tenantA, verifierId)
      expect(members.length).toBeGreaterThanOrEqual(1)
      expect(members.some((m) => m.userId === verifierId && m.role === 'owner')).toBe(true)
    })

    it('cenário 6: cria convite com a nova identidade', async () => {
      const invite = await orgService.createInvitation(
        tenantA,
        'convidado@exemplo.com',
        'member',
        verifierId,
        7,
      )
      expect(invite.token).toBeDefined()
      expect(invite.email).toBe('convidado@exemplo.com')
      expect(invite.role).toBe('member')
    })

    it('cenário 7: aceita convite com a nova identidade', async () => {
      // Criar um usuário convidado com o mesmo email do convite
      const inviteeEmail = 'convidado2@exemplo.com'
      const inviteeId = randomUUID()
      await adminPool.db.insert(t.verifierAuthUser).values({
        id: inviteeId,
        name: 'Convidado',
        email: inviteeEmail,
        role: 'user',
      })

      // Primeiro cria um convite para esse email
      const invite = await orgService.createInvitation(tenantA, inviteeEmail, 'member', verifierId, 7)

      // Aceita o convite com o usuário convidado
      const member = await orgService.acceptInvitation(invite.token, inviteeId)
      expect(member.tenantId).toBe(tenantA)
      expect(member.userId).toBe(inviteeId)
      expect(member.role).toBe('member')
    })
  })

  describe('isolamento entre tenants', () => {
    it('cenário 8: usuário não consegue acessar organização de outro tenant', async () => {
      const org = await orgService.getOrganization(tenantB, verifierId)
      expect(org).toBeNull()

      const members = await orgService.listMembers(tenantB, verifierId)
      expect(members.length).toBe(0)
    })
  })
})
