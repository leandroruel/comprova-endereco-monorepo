import { createLogger, createMetrics } from '@comprova/observability'
import { createDbPool, eq, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import {
  createApiKey,
  createSubject,
  createTenant,
  seedGoldenDataset,
  startTestDb,
  startTestRedis,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import { evidenceSetHashOfObservations, policyHashOf, SCORER_VERSION } from '@comprova/core'
import Redis from 'ioredis'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp, buildFastPathDeps } from './app.js'
import type { AppConfig } from './config.js'
import { batchTick } from './services/batch-processor.js'

// Pré-requisitos de verificabilidade (V-1, V-3, V-5, §8, §9, §12):
//  - issuer/api_key + snapshot de autoridade;
//  - binding de policy/scorer;
//  - digest durável do material e imutabilidade de claim_evidence;
//  - estabilidade dos bindings em replay.

const PEPPER = 'test-pepper-verifiability'
const POLICY_VERSION = '2026.13.1'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const policyYaml = readFileSync(path.join(repoRoot, 'policies', `${POLICY_VERSION}.yaml`), 'utf8')

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
await seedGoldenDataset(adminPool.db)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

const tenantId = await createTenant(adminPool.db, { name: 'verifiability-tenant' })
const key = await createApiKey(adminPool.db, tenantId, PEPPER, {
  scopes: ['validate:read', 'validate:write'],
})

const appPool = createDbPool(db.appUrl)
const config: AppConfig = {
  DATABASE_URL: db.appUrl,
  REDIS_URL: testRedis.url,
  API_KEY_PEPPER: PEPPER,
  PORT: 3000,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  POLICY_VERSION,
  TEMPORAL_ENABLED: false,
  VLM_ENABLED: false,
  TEMPORAL_ADDRESS: 'localhost:7233',
  TEMPORAL_NAMESPACE: 'default',
  TEMPORAL_TASK_QUEUE: 'comprova-deep-t1',
  WORKER_LOOPS: false,
}
const app = await buildApp({
  config,
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

const authJson = { authorization: `Bearer ${key.plaintext}`, 'content-type': 'application/json' }

const postCnpj = (headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/validations',
    headers: { ...authJson, ...headers },
    payload: {
      document: { type: 'CNPJ', value: '12345678000195' },
      address: null,
      mode: 'fast',
      legal_basis: 'FRAUD_PREVENTION',
    },
  })

const validationRow = async (validationId: string) =>
  (await adminPool.db.select().from(t.validation).where(eq(t.validation.validationId, validationId)))[0]

describe('V-1 — issuer e snapshot de autoridade', () => {
  it('grava api_key_id e o snapshot de scopes vigente na emissão', async () => {
    const res = await postCnpj()
    expect(res.statusCode).toBe(200)
    const validationId = res.json().validation_id as string

    const row = await validationRow(validationId)
    if (row === undefined) throw new Error('validation row missing')
    expect(row.apiKeyId).toBe(key.apiKeyId)
    expect(row.tenantId).toBe(tenantId)
    expect(row.issuerScopes).toEqual(['validate:read', 'validate:write'])
  })

  it('a FK composta impede associar api_key de OUTRO tenant', async () => {
    const otherTenant = await createTenant(adminPool.db, { name: 'verifiability-other' })
    const otherKey = await createApiKey(adminPool.db, otherTenant, PEPPER)
    const subject = await createSubject(adminPool.db, tenantId)

    await expect(
      adminPool.db.insert(t.validation).values({
        validationId: randomUUID(),
        tenantId,
        subjectId: subject,
        mode: 'fast',
        status: 'completed',
        policyVersion: POLICY_VERSION,
        legalBasis: 'FRAUD_PREVENTION',
        // api_key de OUTRO tenant:
        apiKeyId: otherKey.apiKeyId,
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    ).rejects.toThrow()
  })

  it('a FK composta impede associar subject de OUTRO tenant', async () => {
    const otherTenant = await createTenant(adminPool.db, { name: 'verifiability-subject-other' })
    const otherSubject = await createSubject(adminPool.db, otherTenant)

    await expect(
      adminPool.db.insert(t.validation).values({
        validationId: randomUUID(),
        tenantId,
        // subject de OUTRO tenant:
        subjectId: otherSubject,
        mode: 'fast',
        status: 'completed',
        policyVersion: POLICY_VERSION,
        legalBasis: 'FRAUD_PREVENTION',
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    ).rejects.toThrow()
  })

  it('revogar a api_key não altera o snapshot histórico da validation', async () => {
    const revocable = await createApiKey(adminPool.db, tenantId, PEPPER, {
      scopes: ['validate:write'],
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/validations',
      headers: { authorization: `Bearer ${revocable.plaintext}`, 'content-type': 'application/json' },
      payload: {
        document: { type: 'CNPJ', value: '12345678000195' },
        address: null,
        mode: 'fast',
        legal_basis: 'FRAUD_PREVENTION',
      },
    })
    expect(res.statusCode).toBe(200)
    const validationId = res.json().validation_id as string

    const before = await validationRow(validationId)
    expect(before?.issuerScopes).toEqual(['validate:write'])

    await adminPool.db
      .update(t.apiKey)
      .set({ revokedAt: new Date() })
      .where(eq(t.apiKey.apiKeyId, revocable.apiKeyId))

    const after = await validationRow(validationId)
    expect(after?.issuerScopes).toEqual(['validate:write'])
    expect(after?.apiKeyId).toBe(revocable.apiKeyId)
  })
})

describe('V-5 / §8 — binding de policy e scorer', () => {
  it('persiste policy_hash (digest do conteúdo efetivo) e scorer_version', async () => {
    const res = await postCnpj()
    const validationId = res.json().validation_id as string
    const row = await validationRow(validationId)
    expect(row?.policyVersion).toBe(POLICY_VERSION)
    expect(row?.policyHash).toBe(policyHashOf(policyYaml))
    expect(row?.scorerVersion).toBe(SCORER_VERSION)
  })

  it('policy_version + policy_hash identificam o conteúdo', () => {
    expect(policyHashOf(policyYaml)).not.toBe(policyHashOf(`${policyYaml}\n# drift`))
  })
})

describe('§9 — evidence-set hash', () => {
  it('é persistido e não-nulo para uma validation nova', async () => {
    const res = await postCnpj()
    const validationId = res.json().validation_id as string
    const row = await validationRow(validationId)
    expect(row?.evidenceSetHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('é reproduzível a partir do estado persistido do banco', async () => {
    const res = await postCnpj()
    const validationId = res.json().validation_id as string
    const row = await validationRow(validationId)
    const claims = await adminPool.db
      .select({ claimId: t.claim.claimId })
      .from(t.claim)
      .where(eq(t.claim.validationId, validationId))
    const claimId = claims[0]?.claimId
    if (claimId === undefined) throw new Error('claim row missing')

    const observations = await adminPool.db
      .select({
        id: t.claimEvidence.claimEvidenceId,
        checker: t.claimEvidence.checker,
        checkerVersion: t.claimEvidence.checkerVersion,
        stance: t.claimEvidence.stance,
        strength: t.claimEvidence.strength,
        confidence: t.claimEvidence.confidence,
        source: t.claimEvidence.source,
        observedAt: t.claimEvidence.observedAt,
        evidenceSha256: t.claimEvidence.evidenceSha256,
        detail: t.claimEvidence.detail,
      })
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimId, claimId))

    expect(evidenceSetHashOfObservations(observations)).toBe(row?.evidenceSetHash)
  })
})

describe('§12 — idempotência preserva os bindings', () => {
  it('replay da mesma requisição não altera issuer/policy/scorer/evidence-set', async () => {
    const headers = { 'idempotency-key': 'verifiability-idem-1' }
    const first = await postCnpj(headers)
    const validationId = first.json().validation_id as string

    const before = await validationRow(validationId)
    const second = await postCnpj(headers)
    const third = await postCnpj(headers)

    expect(second.json().validation_id).toBe(validationId)
    expect(third.json().validation_id).toBe(validationId)

    const after = await validationRow(validationId)
    expect(after?.apiKeyId).toBe(before?.apiKeyId)
    expect(after?.issuerScopes).toEqual(before?.issuerScopes)
    expect(after?.policyVersion).toBe(before?.policyVersion)
    expect(after?.policyHash).toBe(before?.policyHash)
    expect(after?.scorerVersion).toBe(before?.scorerVersion)
    expect(after?.evidenceSetHash).toBe(before?.evidenceSetHash)
  })

  it('não permite reescrever identidade/autoridade/policy da validation', async () => {
    const res = await postCnpj()
    const validationId = res.json().validation_id as string
    const where = eq(t.validation.validationId, validationId)

    await expect(
      adminPool.db.update(t.validation).set({ apiKeyId: randomUUID() }).where(where),
    ).rejects.toThrow()
    await expect(
      adminPool.db
        .update(t.validation)
        .set({ issuerScopes: ['tampered'] })
        .where(where),
    ).rejects.toThrow()
    await expect(
      adminPool.db.update(t.validation).set({ policyHash: 'tampered' }).where(where),
    ).rejects.toThrow()
    await expect(
      adminPool.db.update(t.validation).set({ scorerVersion: 'tampered' }).where(where),
    ).rejects.toThrow()

    // A evolução legítima do ciclo de vida continua permitida.
    await adminPool.db.update(t.validation).set({ status: 'failed' }).where(where)
    const row = await validationRow(validationId)
    expect(row?.status).toBe('failed')
  })
})

const freshClaimId = async (): Promise<string> => {
  const res = await postCnpj()
  const validationId = res.json().validation_id as string
  const claims = await adminPool.db
    .select({ claimId: t.claim.claimId })
    .from(t.claim)
    .where(eq(t.claim.validationId, validationId))
  const claimId = claims[0]?.claimId
  if (claimId === undefined) throw new Error('claim row missing')
  return claimId
}

let materialSeq = 0
const newMaterial = async (sha: Buffer): Promise<string> => {
  const evidenceId = randomUUID()
  await adminPool.db.insert(t.evidence).values({
    evidenceId,
    kind: 'vlm_output',
    provider: 'test',
    s3Uri: `s3://test/evidence/${materialSeq++}-${evidenceId}`,
    sha256: sha,
    capturedAt: null,
    retentionUntil: new Date(Date.now() + 86_400_000),
  })
  return evidenceId
}

const insertObservation = async (
  claimId: string,
  extra: Partial<typeof t.claimEvidence.$inferInsert> = {},
): Promise<string> => {
  const claimEvidenceId = randomUUID()
  await adminPool.db.insert(t.claimEvidence).values({
    claimEvidenceId,
    tenantId,
    claimId,
    checker: 'test_checker',
    checkerVersion: '1',
    stance: 'supports',
    strength: 0.5,
    confidence: 0.5,
    source: 'test',
    observedAt: new Date(),
    ttlSeconds: 3600,
    expiresAt: new Date(Date.now() + 3_600_000),
    detail: {},
    ...extra,
  })
  return claimEvidenceId
}

describe('V-4 — imutabilidade de claim_evidence', () => {
  it('não permite reescrever campos já persistidos (inclusive update geral)', async () => {
    const claimId = await freshClaimId()
    const id = await insertObservation(claimId)

    await expect(
      adminPool.db
        .update(t.claimEvidence)
        .set({ strength: 0.123 })
        .where(eq(t.claimEvidence.claimEvidenceId, id)),
    ).rejects.toThrow()
    await expect(
      adminPool.db
        .update(t.claimEvidence)
        .set({ checker: 'tampered' })
        .where(eq(t.claimEvidence.claimEvidenceId, id)),
    ).rejects.toThrow()
    await expect(
      adminPool.db
        .update(t.claimEvidence)
        .set({ stance: 'contradicts' })
        .where(eq(t.claimEvidence.claimEvidenceId, id)),
    ).rejects.toThrow()

    // Remover/alterar o digest durável também é proibido.
    const materialId = await newMaterial(Buffer.alloc(32, 8))
    const linkedId = await insertObservation(claimId, {
      evidenceId: materialId,
      evidenceSha256: Buffer.alloc(32, 8),
    })
    await expect(
      adminPool.db
        .update(t.claimEvidence)
        .set({ evidenceSha256: null })
        .where(eq(t.claimEvidence.claimEvidenceId, linkedId)),
    ).rejects.toThrow()
  })

  it('permite exclusivamente a desvinculação do material (evidence_id X -> NULL)', async () => {
    const claimId = await freshClaimId()
    const sha = Buffer.alloc(32, 7)
    const materialId = await newMaterial(sha)
    const id = await insertObservation(claimId, { evidenceId: materialId, evidenceSha256: sha })

    // X -> NULL é a operação legítima de retenção; o digest é preservado.
    await adminPool.db
      .update(t.claimEvidence)
      .set({ evidenceId: null })
      .where(eq(t.claimEvidence.claimEvidenceId, id))
    const unlinked = await adminPool.db
      .select({ evidenceId: t.claimEvidence.evidenceId, evidenceSha256: t.claimEvidence.evidenceSha256 })
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimEvidenceId, id))
    expect(unlinked[0]?.evidenceId).toBeNull()
    expect(unlinked[0]?.evidenceSha256).toEqual(sha)

    // NULL -> X é proibido (só a desvinculação é permitida após a criação).
    await expect(
      adminPool.db
        .update(t.claimEvidence)
        .set({ evidenceId: materialId, evidenceSha256: sha })
        .where(eq(t.claimEvidence.claimEvidenceId, id)),
    ).rejects.toThrow()
  })
})

describe('V-3 — binding criptográfico do material', () => {
  it('exige evidence_sha256 = evidence.sha256 quando há material', async () => {
    const claimId = await freshClaimId()
    const sha = Buffer.alloc(32, 3)
    const materialId = await newMaterial(sha)

    // Digest divergente -> rejeitado no INSERT.
    await expect(
      insertObservation(claimId, { evidenceId: materialId, evidenceSha256: Buffer.alloc(32, 4) }),
    ).rejects.toThrow()

    // Digest correto -> aceito.
    const id = await insertObservation(claimId, { evidenceId: materialId, evidenceSha256: sha })
    const linked = await adminPool.db
      .select({ evidenceId: t.claimEvidence.evidenceId, evidenceSha256: t.claimEvidence.evidenceSha256 })
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimEvidenceId, id))
    expect(linked[0]?.evidenceId).toBe(materialId)
    expect(linked[0]?.evidenceSha256).toEqual(sha)
  })

  it('rejeita evidence_id inexistente e evidence_sha256 ausente', async () => {
    const claimId = await freshClaimId()

    await expect(
      insertObservation(claimId, { evidenceId: randomUUID(), evidenceSha256: Buffer.alloc(32, 5) }),
    ).rejects.toThrow()

    const sha = Buffer.alloc(32, 6)
    const materialId = await newMaterial(sha)
    await expect(
      insertObservation(claimId, { evidenceId: materialId, evidenceSha256: null }),
    ).rejects.toThrow()
  })
})

describe('imutabilidade da asserção (claim)', () => {
  const claimOf = async (validationId: string): Promise<string> => {
    const rows = await adminPool.db
      .select({ claimId: t.claim.claimId })
      .from(t.claim)
      .where(eq(t.claim.validationId, validationId))
    const claimId = rows[0]?.claimId
    if (claimId === undefined) throw new Error('claim row missing')
    return claimId
  }

  it('não permite reescrever o conteúdo da asserção', async () => {
    const res = await postCnpj()
    const claimId = await claimOf(res.json().validation_id as string)
    const where = eq(t.claim.claimId, claimId)

    await expect(adminPool.db.update(t.claim).set({ type: 'address_exists' }).where(where)).rejects.toThrow()
    await expect(adminPool.db.update(t.claim).set({ subjectType: 'person' }).where(where)).rejects.toThrow()
    await expect(
      adminPool.db.update(t.claim).set({ validationId: randomUUID() }).where(where),
    ).rejects.toThrow()
    await expect(
      adminPool.db.update(t.claim).set({ targetType: 'address', subjectId: randomUUID() }).where(where),
    ).rejects.toThrow()
  })

  it('DELETE do claim continua permitido (retenção/LGPD)', async () => {
    const res = await postCnpj()
    const claimId = await claimOf(res.json().validation_id as string)
    await adminPool.db.delete(t.claim).where(eq(t.claim.claimId, claimId))
    const remaining = await adminPool.db
      .select({ claimId: t.claim.claimId })
      .from(t.claim)
      .where(eq(t.claim.claimId, claimId))
    expect(remaining.length).toBe(0)
  })
})

describe('identidade imutável da validation (completude de 0030)', () => {
  it('não permite reescrever validation_id nem legal_basis', async () => {
    const res = await postCnpj()
    const validationId = res.json().validation_id as string
    const where = eq(t.validation.validationId, validationId)

    await expect(
      adminPool.db.update(t.validation).set({ validationId: randomUUID() }).where(where),
    ).rejects.toThrow()
    await expect(
      adminPool.db.update(t.validation).set({ legalBasis: 'CONTRACT_EXECUTION' }).where(where),
    ).rejects.toThrow()

    // A identidade segue intacta.
    const row = await validationRow(validationId)
    expect(row?.legalBasis).toBe('FRAUD_PREVENTION')
  })
})

describe('V-1 — actor de origem batch', () => {
  it('propaga o user_id do lote para validation.user_id (sem api_key)', async () => {
    const userId = `batch-user-${randomUUID()}`
    await adminPool.db
      .insert(t.authUser)
      .values({ id: userId, name: 'Batch Owner', email: `${userId}@test.local` })

    const batchId = randomUUID()
    const itemId = randomUUID()
    await adminPool.db.insert(t.batch).values({
      batchId,
      tenantId,
      userId,
      status: 'queued',
      totalItems: 1,
      mode: 'fast',
      legalBasis: 'FRAUD_PREVENTION',
    })
    await adminPool.db.insert(t.batchItem).values({
      itemId,
      batchId,
      tenantId,
      position: 0,
      docType: 'CNPJ',
      docDigits: '12345678000195',
      status: 'pending',
    })

    const fastPath = buildFastPathDeps(appPool.db, config)
    await batchTick({ adminDb: adminPool.db, fastPath })

    const items = await adminPool.db
      .select({ validationId: t.batchItem.validationId })
      .from(t.batchItem)
      .where(eq(t.batchItem.itemId, itemId))
    const validationId = items[0]?.validationId
    if (validationId === undefined || validationId === null) {
      throw new Error('batch item was not linked to a validation')
    }

    const row = await validationRow(validationId)
    expect(row?.userId).toBe(userId)
    // Sem credencial sintética: a origem batch não inventa api_key.
    expect(row?.apiKeyId).toBeNull()
  })
})
