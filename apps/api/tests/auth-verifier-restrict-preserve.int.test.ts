import { afterAll, describe, expect, it } from 'vitest'
import { startTestDb, startTestRedis, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import { createDbPool, eq, sql, runMigrations } from '@comprova/db'
import Redis from 'ioredis'
import postgres from 'postgres'
import { createLogger, createMetrics } from '@comprova/observability'
import { buildApp } from '../src/app.js'
import * as t from '@comprova/db'

const PEPPER = 'test-pepper-restrict-preserve'

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

describe('preservação histórica com ON DELETE RESTRICT', () => {
  it('impede exclusão de verifier_user referenciado por organization_member', async () => {
    const verifierUserId = crypto.randomUUID()

    // Insere diretamente em verifier_user (usuário autenticado pelo dashboard do Verifier)
    await adminClient.unsafe(`
      INSERT INTO verifier_user (id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at)
      VALUES ('${verifierUserId}', 'Usuário Verifier', 'verifier@exemplo.com', false, NULL, 'user', false, NULL, NULL, now(), now())
      ON CONFLICT (id) DO NOTHING
    `)

    const { createTenant } = await import('@comprova/testing')
    const tenantId: string = await createTenant(adminPool.db, { name: 'org-restrict-test' })

    // Cria membership referenciando o verifier_user
    await adminPool.db.insert(t.organizationMember).values({
      organizationMemberId: crypto.randomUUID(),
      tenantId,
      userId: verifierUserId,
      role: 'owner',
    })

    // Tenta excluir o usuário — deve falhar por RESTRICT
    await expect(adminClient`DELETE FROM verifier_user WHERE id = ${verifierUserId}`).rejects.toThrow(
      /foreign key constraint|violates foreign key/,
    )

    // Confirma que o usuário ainda existe
    const userStillThere = await adminPool.db
      .select({ id: t.verifierAuthUser.id })
      .from(t.verifierAuthUser)
      .where(eq(t.verifierAuthUser.id, verifierUserId))
      .limit(1)
    expect(userStillThere.length).toBe(1)

    // Confirma que o membership ainda existe
    const memberStillThere = await adminPool.db
      .select({ count: sql<number>`count(*)::int` })
      .from(t.organizationMember)
      .where(eq(t.organizationMember.userId, verifierUserId))
    expect(memberStillThere[0]!.count).toBe(1)
  })

  it('impede exclusão de verifier_user referenciado por batch', async () => {
    const verifierUserId = crypto.randomUUID()

    await adminClient.unsafe(`
      INSERT INTO verifier_user (id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at)
      VALUES ('${verifierUserId}', 'Usuário Verifier Batch', 'verifier-batch@exemplo.com', false, NULL, 'user', false, NULL, NULL, now(), now())
      ON CONFLICT (id) DO NOTHING
    `)

    const { createTenant } = await import('@comprova/testing')
    const tenantId: string = await createTenant(adminPool.db, { name: 'org-restrict-batch' })

    const batchId = crypto.randomUUID()
    await adminPool.db.insert(t.batch).values({
      batchId,
      tenantId,
      userId: verifierUserId,
      status: 'queued',
      totalItems: 1,
      mode: 'fast',
      legalBasis: 'FRAUD_PREVENTION',
    })

    // Tenta excluir o usuário — deve falhar por RESTRICT
    await expect(adminClient`DELETE FROM verifier_user WHERE id = ${verifierUserId}`).rejects.toThrow(
      /foreign key constraint|violates foreign key/,
    )

    // Confirma que o usuário ainda existe
    const userStillThere = await adminPool.db
      .select({ id: t.verifierAuthUser.id })
      .from(t.verifierAuthUser)
      .where(eq(t.verifierAuthUser.id, verifierUserId))
      .limit(1)
    expect(userStillThere.length).toBe(1)

    // Confirma que o batch ainda existe
    const batchStillThere = await adminPool.db
      .select({ count: sql<number>`count(*)::int` })
      .from(t.batch)
      .where(eq(t.batch.batchId, batchId))
    expect(batchStillThere[0]!.count).toBe(1)
  })

  it('impede exclusão de verifier_user referenciado por validation', async () => {
    const verifierUserId = crypto.randomUUID()

    await adminClient.unsafe(`
      INSERT INTO verifier_user (id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at)
      VALUES ('${verifierUserId}', 'Usuário Verifier Validation', 'verifier-validation@exemplo.com', false, NULL, 'user', false, NULL, NULL, now(), now())
      ON CONFLICT (id) DO NOTHING
    `)

    const { createTenant } = await import('@comprova/testing')
    const tenantId: string = await createTenant(adminPool.db, { name: 'org-restrict-validation' })

    const subjectId = crypto.randomUUID()
    await adminPool.db.insert(t.subject).values({
      subjectId,
      tenantId,
      docType: 'CNPJ',
      docHmac: Buffer.from('doc-hmac-test'),
    })

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
      userId: verifierUserId,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    })

    // Tenta excluir o usuário — deve falhar por RESTRICT
    await expect(adminClient`DELETE FROM verifier_user WHERE id = ${verifierUserId}`).rejects.toThrow(
      /foreign key constraint|violates foreign key/,
    )

    // Confirma que o usuário ainda existe
    const userStillThere = await adminPool.db
      .select({ id: t.verifierAuthUser.id })
      .from(t.verifierAuthUser)
      .where(eq(t.verifierAuthUser.id, verifierUserId))
      .limit(1)
    expect(userStillThere.length).toBe(1)

    // Confirma que a validation ainda existe
    const validationStillThere = await adminPool.db
      .select({ count: sql<number>`count(*)::int` })
      .from(t.validation)
      .where(eq(t.validation.validationId, validationId))
    expect(validationStillThere[0]!.count).toBe(1)
  })

  it('permite exclusão de verifier_user SEM referências históricas', async () => {
    const verifierUserId = crypto.randomUUID()

    await adminClient.unsafe(`
      INSERT INTO verifier_user (id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at)
      VALUES ('${verifierUserId}', 'Usuário Sem Referências', 'verifier-no-refs@exemplo.com', false, NULL, 'user', false, NULL, NULL, now(), now())
      ON CONFLICT (id) DO NOTHING
    `)

    // Exclusão deve funcionar pois não há referências
    await adminClient`DELETE FROM verifier_user WHERE id = ${verifierUserId}`

    // Confirma que o usuário foi excluído
    const userGone = await adminPool.db
      .select({ id: t.verifierAuthUser.id })
      .from(t.verifierAuthUser)
      .where(eq(t.verifierAuthUser.id, verifierUserId))
      .limit(1)
    expect(userGone.length).toBe(0)
  })
})
