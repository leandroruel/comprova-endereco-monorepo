import { afterAll, describe, expect, it } from 'vitest'
import { startTestDb, startTestRedis, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import { createDbPool, eq, sql, runMigrations } from '@comprova/db'
import Redis from 'ioredis'
import * as fs from 'node:fs'
import * as path from 'node:path'
import postgres from 'postgres'
import { createLogger, createMetrics } from '@comprova/observability'
import { buildApp } from '../src/app.js'
import * as t from '@comprova/db'

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'packages', 'db', 'migrations')

const readMigration = (name: string): string => fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')

const PEPPER = 'test-pepper-migration-upgrade'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminClient = postgres(db.adminUrl, { max: 1 })
const adminPool = createDbPool(db.adminUrl)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

await adminClient`GRANT USAGE ON SCHEMA public TO app_user`
await adminClient`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO app_user`

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
  await appPool.end()
  await adminPool.end()
  await testRedis.stop()
  await adminClient.end()
  await db.stop()
})

describe('upgrade de migrations — identidade verifier_user', () => {
  it('0056 + dados legacy criados depois + reconciliação + 0068/0070/0071 preserva registros', async () => {
    // Todas as migrations já foram aplicadas (incluindo 0056, 0068, 0070, 0071, 0072, 0073).
    // Agora simulamos um usuário legacy criado DEPOIS da migration 0056.

    // 1. Insere um usuário legado diretamente na tabela `user` (após a 0056)
    const legacyUserId = 'legacy-user-001'
    await adminClient.unsafe(`
      INSERT INTO "user" (id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at)
      VALUES ('legacy-user-001', 'Legacy User', 'legacy@exemplo.com', false, NULL, 'user', false, NULL, NULL, now(), now())
      ON CONFLICT (id) DO NOTHING
    `)

    // 2. Verifica que o usuário existe na tabela legada `user` mas NÃO em verifier_user
    const legacyUserInUser = await adminPool.db
      .select({ id: sql<string>`id` })
      .from(sql`"user"`)
      .where(eq(sql`"user".id`, legacyUserId))
      .limit(1)
    expect(legacyUserInUser.length).toBe(1)

    const legacyUserInVerifier = await adminPool.db
      .select({ id: t.verifierAuthUser.id })
      .from(t.verifierAuthUser)
      .where(eq(t.verifierAuthUser.id, legacyUserId))
      .limit(1)
    expect(legacyUserInVerifier.length).toBe(0)

    // 3. Reconciliação: copia o usuário legacy para verifier_user (simula o que
    // a migration 0056 faria para usuários existentes no momento da execução)
    await adminClient.unsafe(`
      INSERT INTO verifier_user (id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at)
      SELECT id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at
      FROM "user" WHERE id = 'legacy-user-001'
      ON CONFLICT (id) DO NOTHING
    `)

    const verifierUserAfter = await adminPool.db
      .select({ id: t.verifierAuthUser.id })
      .from(t.verifierAuthUser)
      .where(eq(t.verifierAuthUser.id, legacyUserId))
      .limit(1)
    expect(verifierUserAfter.length).toBe(1)

    // 4. Cria um tenant e registros relacionados referenciando o usuário legacy
    // (agora funciona porque o usuário existe em verifier_user)
    const { createTenant } = await import('@comprova/testing')
    const tenantId: string = await createTenant(adminPool.db, { name: 'org-migration-upgrade' })

    // organization_member referenciando o usuário legacy (agora válido porque existe em verifier_user)
    await adminPool.db.insert(t.organizationMember).values({
      organizationMemberId: crypto.randomUUID(),
      tenantId,
      userId: legacyUserId,
      role: 'owner',
    })

    // batch referenciando o usuário legacy
    const batchId = crypto.randomUUID()
    await adminPool.db.insert(t.batch).values({
      batchId,
      tenantId,
      userId: legacyUserId,
      status: 'queued',
      totalItems: 1,
      mode: 'fast',
      legalBasis: 'FRAUD_PREVENTION',
    })

    // Cria um subject para a validação
    const subjectId = crypto.randomUUID()
    await adminPool.db.insert(t.subject).values({
      subjectId,
      tenantId,
      docType: 'CNPJ',
      docHmac: Buffer.from('doc-hmac-test'),
    })

    // validation referenciando o usuário legacy
    const validationId = crypto.randomUUID()
    await adminPool.db.insert(t.validation).values({
      validationId,
      tenantId,
      subjectId,
      mode: 'fast',
      status: 'completed',
      verdict: 'RESIDENTIAL',
      score: 0.8,
      confidence: 0.9,
      policyVersion: '2026.11.1',
      legalBasis: 'FRAUD_PREVENTION',
      userId: legacyUserId,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    })

    // 5. Verifica que os registros e relacionamentos foram preservados
    const memberAfter = await adminPool.db
      .select({ userId: t.organizationMember.userId, role: t.organizationMember.role })
      .from(t.organizationMember)
      .where(eq(t.organizationMember.userId, legacyUserId))
      .limit(1)
    expect(memberAfter.length).toBe(1)
    expect(memberAfter[0]!.role).toBe('owner')

    const batchAfter = await adminPool.db
      .select({ userId: t.batch.userId, status: t.batch.status })
      .from(t.batch)
      .where(eq(t.batch.batchId, batchId))
      .limit(1)
    expect(batchAfter.length).toBe(1)
    expect(batchAfter[0]!.userId).toBe(legacyUserId)

    const validationAfter = await adminPool.db
      .select({ userId: t.validation.userId, tenantId: t.validation.tenantId })
      .from(t.validation)
      .where(eq(t.validation.validationId, validationId))
      .limit(1)
    expect(validationAfter.length).toBe(1)
    expect(validationAfter[0]!.userId).toBe(legacyUserId)
    expect(validationAfter[0]!.tenantId).toBe(tenantId)

    // Verifica que as FKs são válidas (os registros de verifier_user existem para os IDs)
    const verifierUser = await adminPool.db
      .select({ id: t.verifierAuthUser.id })
      .from(t.verifierAuthUser)
      .where(eq(t.verifierAuthUser.id, legacyUserId))
      .limit(1)
    expect(verifierUser.length).toBe(1)

    // 6. Testa que RESTRICT impede a exclusão do verifier_user com referências históricas
    await expect(adminClient`DELETE FROM verifier_user WHERE id = ${legacyUserId}`).rejects.toThrow(
      /foreign key constraint|violates foreign key/,
    )

    // 7. Confirma que o histórico permanece intacto após a tentativa falha de exclusão
    const memberStillThere = await adminPool.db
      .select({ count: sql<number>`count(*)::int` })
      .from(t.organizationMember)
      .where(eq(t.organizationMember.userId, legacyUserId))
    expect(memberStillThere[0]!.count).toBe(1)

    const validationStillThere = await adminPool.db
      .select({ count: sql<number>`count(*)::int` })
      .from(t.validation)
      .where(eq(t.validation.validationId, validationId))
    expect(validationStillThere[0]!.count).toBe(1)

    // 8. Verifica que inserir um órfão é rejeitado pelo RESTRICT
    const orphanUserId = 'orphan-user-999'
    await expect(
      adminPool.db.insert(t.organizationMember).values({
        organizationMemberId: crypto.randomUUID(),
        tenantId,
        userId: orphanUserId,
        role: 'member',
      }),
    ).rejects.toThrow()
  })

  it('migration 0073 contém verificação de órfãos para impedir aplicação com registros inválidos', async () => {
    const migration0073 = readMigration('0073_preflight_verifier_user_orphans.sql')

    // Verifica que a migration contém a verificação de órfãos
    expect(migration0073).toContain('órfão')
    expect(migration0073).toContain('organization_member')
    expect(migration0073).toContain('batch')
    expect(migration0073).toContain('validation')
    expect(migration0073).toContain('verifier_user')
    expect(migration0073).toContain('RAISE EXCEPTION')
  })
})
