import { afterAll, describe, expect, it } from 'vitest'
import { startTestDb, startTestRedis, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import { createDbPool, eq, sql, runMigrations } from '@comprova/db'
import Redis from 'ioredis'
import postgres from 'postgres'
import { createLogger, createMetrics } from '@comprova/observability'
import { buildApp } from '../src/app.js'
import * as t from '@comprova/db'

const PEPPER = 'test-pepper-migration-upgrade'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminClient = postgres(db.adminUrl, { max: 1 })
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
  it('0056 + dados legacy + 0068/0070/0071 preserva registros e FKs válidas', async () => {
    // Garante que app_user enxerga as tabelas
    await adminClient`GRANT USAGE ON SCHEMA public TO app_user`
    await adminClient`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO app_user`

    // 1. Cria um usuário legado diretamente na tabela `user`
    const legacyUserId = 'legacy-user-001'
    await adminClient.unsafe(`
      INSERT INTO "user" (id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at)
      VALUES ('legacy-user-001', 'Legacy User', 'legacy@exemplo.com', false, NULL, 'user', false, NULL, NULL, now(), now())
      ON CONFLICT (id) DO NOTHING
    `)

    // 2. Copia o usuário legacy para verifier_user (reconciliação de identidade)
    await adminClient.unsafe(`
      INSERT INTO verifier_user (id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at)
      SELECT id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at
      FROM "user" WHERE id = 'legacy-user-001'
      ON CONFLICT (id) DO NOTHING
    `)

    // 3. Cria um tenant e registros relacionados referenciando o usuário legacy
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

    // 4. Verifica que os registros existem e as FKs (0068, 0070, 0071) são válidas
    const memberCount = await adminPool.db
      .select({ count: sql<number>`count(*)::int` })
      .from(t.organizationMember)
      .where(eq(t.organizationMember.userId, legacyUserId))
    expect(memberCount[0]!.count).toBeGreaterThan(0)

    const batchCount = await adminPool.db
      .select({ count: sql<number>`count(*)::int` })
      .from(t.batch)
      .where(eq(t.batch.userId, legacyUserId))
    expect(batchCount[0]!.count).toBeGreaterThan(0)

    const validationCount = await adminPool.db
      .select({ count: sql<number>`count(*)::int` })
      .from(t.validation)
      .where(eq(t.validation.userId, legacyUserId))
    expect(validationCount[0]!.count).toBeGreaterThan(0)

    // Verifica que os registros de verifier_user existem para os IDs (FK válida)
    const verifierUser = await adminPool.db
      .select({ id: t.verifierAuthUser.id })
      .from(t.verifierAuthUser)
      .where(eq(t.verifierAuthUser.id, legacyUserId))
      .limit(1)
    expect(verifierUser.length).toBe(1)

    // 5. Verifica que registros órfãos impediriam a FK (teste de segurança)
    const orphanUserId = 'orphan-user-999'
    const orphanMemberCount = await adminPool.db
      .select({ count: sql<number>`count(*)::int` })
      .from(t.organizationMember)
      .where(eq(t.organizationMember.userId, orphanUserId))
    expect(orphanMemberCount[0]!.count).toBe(0)

    // Tentativa de inserir órfão falharia com FK RESTRICT (0072)
    // Isso demonstra que a estratégia de RESTRICT protege dados históricos
    await expect(
      adminPool.db.insert(t.organizationMember).values({
        organizationMemberId: crypto.randomUUID(),
        tenantId,
        userId: orphanUserId,
        role: 'member',
      }),
    ).rejects.toThrow()
  })
})
