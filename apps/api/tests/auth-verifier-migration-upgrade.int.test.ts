import { afterAll, describe, expect, it } from 'vitest'
import { startTestDb, startTestRedis, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import { createDbPool, eq, sql } from '@comprova/db'
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
const adminClient = postgres(db.adminUrl, { max: 1 })
const adminPool = createDbPool(db.adminUrl)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

// Garante que o role app_user existe (criado na migration 0002, não aplicada aqui)
await adminClient.unsafe(`
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
      CREATE ROLE app_user LOGIN PASSWORD 'disabled';
    END IF;
  END $$;
`)

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
  it('0056 + dados legacy criados depois da 0056 + reconciliação + 0068/0070/0071 preserva registros', async () => {
    // 1. Executa apenas as migrations até a 0056 (incluindo), que criam as
    // tabelas admin_user, verifier_user, etc.
    const migrationsUpTo0056 = [
      '0001_extensions.sql',
      '0002_tenancy.sql',
      '0003_reference.sql',
      '0004_addresses.sql',
      '0005_validation.sql',
      '0006_events.sql',
      '0007_rls.sql',
      '0008_grants.sql',
      '0009_reference_maps.sql',
      '0010_grants_fastpath.sql',
      '0011_batch.sql',
      '0012_webhook_delivery_payload.sql',
      '0013_validation_deep_context.sql',
      '0014_evidence_retention.sql',
      '0015_municipio_nullable.sql',
      '0016_idempotency_request_hash.sql',
      '0017_partition_default.sql',
      '0018_estabelecimento_history.sql',
      '0019_auth.sql',
      '0020_validation_user_id.sql',
      '0021_batch_user_export.sql',
      '0022_claim_evidence.sql',
      '0023_claim_evidence_material.sql',
      '0024_claim_evidence_signal_unique.sql',
      '0025_claim_subject_tenant_fk.sql',
      '0026_claim_evidence_signal_guard.sql',
      '0027_drop_validation_idem_uq.sql',
      '0028_verifiability_bindings.sql',
      '0029_validation_subject_tenant_fk.sql',
      '0030_assertion_immutability.sql',
      '0031_issuer_signing_key.sql',
      '0032_credential_status.sql',
      '0033_issuer_signing_key_revocation.sql',
      '0034_credential_issuance.sql',
      '0035_credential_status_reason.sql',
      '0036_validation_last_evaluated_binding.sql',
      '0037_credential_status_reason_validate.sql',
      '0038_issuer_signing_key_kms_reference.sql',
      '0039_evidence_artifact.sql',
      '0040_evidence_intake.sql',
      '0041_evidence_analysis.sql',
      '0042_evidence_verification.sql',
      '0043_evidence_verification_attempt.sql',
      '0044_fiscal_evidence.sql',
      '0045_validation_fiscal_reassessment.sql',
      '0046_validation_fiscal_reassessment_validate.sql',
      '0047_user_role.sql',
      '0048_better_auth_admin.sql',
      '0049_organizations.sql',
      '0050_organizations_rls.sql',
      '0051_organizations_terms_document_hash.sql',
      '0052_holder_kyc.sql',
      '0053_usage_metering.sql',
      '0054_usage_quota_blocked.sql',
      '0055_grant_select_on_tenant.sql',
      '0056_auth_separate.sql',
    ]
    for (const name of migrationsUpTo0056) {
      await adminClient.unsafe(readMigration(name))
    }
    await adminClient`GRANT USAGE ON SCHEMA public TO app_user`
    await adminClient`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO app_user`

    // 2. Insere um usuário legado diretamente na tabela `user` (simula conta
    // criada depois da migration 0056). Este usuário existe apenas na tabela
    // legada `user`, não em verifier_user.
    const legacyUserId = 'legacy-user-001'
    await adminClient.unsafe(`
      INSERT INTO "user" (id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at)
      VALUES ('legacy-user-001', 'Legacy User', 'legacy@exemplo.com', false, NULL, 'user', false, NULL, NULL, now(), now())
      ON CONFLICT (id) DO NOTHING
    `)

    // 3. Cria um tenant e registros relacionados referenciando o usuário legacy
    const { createTenant } = await import('@comprova/testing')
    const tenantId: string = await createTenant(adminPool.db, { name: 'org-migration-upgrade' })

    // Cria um subject para a validação
    const subjectId = crypto.randomUUID()
    await adminPool.db.insert(t.subject).values({
      subjectId,
      tenantId,
      docType: 'CNPJ',
      docHmac: Buffer.from('doc-hmac-test'),
    })

    // organization_member referenciando o usuário legacy
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

    // 4. Verifica que os registros existem antes das migrations 0068/0070/0071
    const memberCountBefore = await adminPool.db
      .select({ count: sql<number>`count(*)::int` })
      .from(t.organizationMember)
      .where(eq(t.organizationMember.userId, legacyUserId))
    expect(memberCountBefore[0]!.count).toBeGreaterThan(0)

    const batchCountBefore = await adminPool.db
      .select({ count: sql<number>`count(*)::int` })
      .from(t.batch)
      .where(eq(t.batch.userId, legacyUserId))
    expect(batchCountBefore[0]!.count).toBeGreaterThan(0)

    const validationCountBefore = await adminPool.db
      .select({ count: sql<number>`count(*)::int` })
      .from(t.validation)
      .where(eq(t.validation.userId, legacyUserId))
    expect(validationCountBefore[0]!.count).toBeGreaterThan(0)

    // 5. Reconciliação: copia o usuário legacy para verifier_user (simula o
    // que a migration 0056 faria para usuários existentes no momento de sua
    // execução). Isso é necessário porque a 0067_orphan_preflight verifica
    // se não há órfãos antes de permitir a alteração das FKs.
    await adminClient.unsafe(`
      INSERT INTO verifier_user (id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at)
      SELECT id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at
      FROM "user" WHERE id = 'legacy-user-001'
      ON CONFLICT (id) DO NOTHING
    `)

    // 6. Executa as migrations restantes na ordem real de produção
    for (const name of [
      '0067_orphan_preflight.sql',
      '0068_organization_member_verifier_user_fk.sql',
      '0069_organization_invitation_verifier_user_id.sql',
      '0070_batch_verifier_user_fk.sql',
      '0071_validation_user_id_verifier_user_fk.sql',
      '0072_reconcile_verifier_user_fk_restrict.sql',
    ]) {
      await adminClient.unsafe(readMigration(name))
    }

    // 7. Verifica que os registros e relacionamentos foram preservados
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

    // 8. Testa que RESTRICT impede a exclusão do verifier_user com referências históricas
    await expect(adminClient`DELETE FROM verifier_user WHERE id = ${legacyUserId}`).rejects.toThrow(
      /foreign key constraint|violates foreign key/,
    )

    // 9. Confirma que o histórico permanece intacto após a tentativa falha de exclusão
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

    // 10. Verifica que inserir um órfão é rejeitado pelo RESTRICT
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

  it('migration 0067 contém preflight de órfãos para impedir aplicação com registros inválidos', async () => {
    const migration0067 = readMigration('0067_orphan_preflight.sql')

    // Verifica que a migration contém a verificação de órfãos
    expect(migration0067).toContain('órfão')
    expect(migration0067).toContain('organization_member')
    expect(migration0067).toContain('batch')
    expect(migration0067).toContain('validation')
    expect(migration0067).toContain('verifier_user')
    expect(migration0067).toContain('RAISE EXCEPTION')
  })
})
