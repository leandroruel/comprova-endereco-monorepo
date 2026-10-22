import {
  createTenant,
  createSubject,
  createValidation,
  startTestDb,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import { createDbPool, eq, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import { createLogger } from '@comprova/observability'
import { makeFakeObjectStore } from '@comprova/providers'
import type { ObjectStore } from '@comprova/providers'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { validationRetentionTick } from './retention.service.js'
import { makeEvidenceWriter } from '../evidence/evidence.service.js'
import { retentionTick } from '../evidence/evidence-retention.service.js'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const tenant = await createTenant(adminPool.db, { name: 'ret-tenant' })

afterAll(async () => {
  await adminPool.end()
  await db.stop()
})

describe('retention de validacoes (expires_at)', () => {
  it('remove validacoes expiradas com sinais e idempotencia, mantem vigentes', async () => {
    const subject = await createSubject(adminPool.db, tenant)

    const expired = await createValidation(adminPool.db, tenant, subject)
    await adminPool.db
      .update(t.validation)
      .set({ expiresAt: new Date(Date.now() - 86_400_000) })
      .where(eq(t.validation.validationId, expired))
    await adminPool.db.insert(t.signal).values({
      signalId: crypto.randomUUID(),
      validationId: expired,
      checkerId: 'document_integrity',
      checkerVersion: '1.0.0',
      stance: 'supports',
      strength: 0.5,
      confidence: 1,
      source: 'test',
      observedAt: new Date(),
      ttlSeconds: 3600,
      detail: {},
    })
    await adminPool.db.insert(t.validationIdempotency).values({
      tenantId: tenant,
      idempotencyKey: 'retention-expired-key',
      validationId: expired,
    })

    const fresh = await createValidation(adminPool.db, tenant, subject)
    await adminPool.db.insert(t.validationIdempotency).values({
      tenantId: tenant,
      idempotencyKey: 'retention-fresh-key',
      validationId: fresh,
    })

    const removed = await validationRetentionTick(adminPool.db, makeFakeObjectStore())
    expect(removed).toBeGreaterThanOrEqual(1)

    const goneSignals = await adminPool.db.select().from(t.signal).where(eq(t.signal.validationId, expired))
    expect(goneSignals.length).toBe(0)

    const stillFresh = await adminPool.db
      .select({ validationId: t.validation.validationId })
      .from(t.validation)
      .where(eq(t.validation.validationId, fresh))
    expect(stillFresh.length).toBe(1)

    const audit = await adminPool.db
      .select()
      .from(t.auditLog)
      .where(eq(t.auditLog.action, 'validation.expired'))
    expect(audit.length).toBeGreaterThanOrEqual(1)
  })
})

// ALTO-1: a retenção deve tratar o grafo claim_evidence -> claim como parte da
// validation, sem deixar órfãos, e SEM remover subject/canonical_address.
describe('retention do grafo claim/claim_evidence (ALTO-1)', () => {
  it('remove claim e claim_evidence da validation expirada e preserva subject/canonical_address', async () => {
    const subject = await createSubject(adminPool.db, tenant)
    const addressId = randomUUID()
    await adminPool.db.insert(t.canonicalAddress).values({
      addressId,
      buildingKey: randomBytes(16),
    })

    const validationId = await createValidation(adminPool.db, tenant, subject)
    await adminPool.db
      .update(t.validation)
      .set({ expiresAt: new Date(Date.now() - 86_400_000), addressId })
      .where(eq(t.validation.validationId, validationId))

    const claimId = randomUUID()
    await adminPool.db.insert(t.claim).values({
      claimId,
      tenantId: tenant,
      validationId,
      subjectId: subject,
      addressId,
      type: 'address_exists',
      subjectType: 'organization',
      targetType: 'address',
    })

    const signalId = randomUUID()
    await adminPool.db.insert(t.signal).values({
      signalId,
      validationId,
      checkerId: 'document_integrity',
      checkerVersion: '1.0.0',
      stance: 'supports',
      strength: 0.5,
      confidence: 1,
      source: 'test',
      observedAt: new Date(),
      ttlSeconds: 3600,
      detail: {},
    })
    await adminPool.db.insert(t.claimEvidence).values({
      claimEvidenceId: randomUUID(),
      tenantId: tenant,
      claimId,
      signalId,
      checker: 'document_integrity',
      checkerVersion: '1.0.0',
      stance: 'supports',
      strength: 0.5,
      confidence: 1,
      source: 'test',
      observedAt: new Date(),
      ttlSeconds: 3600,
      expiresAt: new Date(Date.now() + 3_600_000),
      detail: {},
    })

    await validationRetentionTick(adminPool.db, makeFakeObjectStore())

    expect(
      (await adminPool.db.select().from(t.claim).where(eq(t.claim.validationId, validationId))).length,
    ).toBe(0)
    expect(
      (await adminPool.db.select().from(t.claimEvidence).where(eq(t.claimEvidence.claimId, claimId))).length,
    ).toBe(0)
    expect(
      (await adminPool.db.select().from(t.signal).where(eq(t.signal.validationId, validationId))).length,
    ).toBe(0)
    expect(
      (await adminPool.db.select().from(t.validation).where(eq(t.validation.validationId, validationId)))
        .length,
    ).toBe(0)

    // Entidades com ciclo de vida próprio permanecem.
    expect((await adminPool.db.select().from(t.subject).where(eq(t.subject.subjectId, subject))).length).toBe(
      1,
    )
    expect(
      (
        await adminPool.db
          .select()
          .from(t.canonicalAddress)
          .where(eq(t.canonicalAddress.addressId, addressId))
      ).length,
    ).toBe(1)
  })
})

// ALTO-2: a retenção de material deve desvincular referências ANTES de remover
// o objeto/registro, sem deixar ponteiros inválidos.
describe('retention de evidence material (ALTO-2)', () => {
  it('desvincula claim_evidence/signal e remove o artefato expirado', async () => {
    const store = makeFakeObjectStore()
    const writer = makeEvidenceWriter(adminPool.db, store)
    const evidenceId = await writer({
      kind: 'vlm_output',
      provider: 'fake',
      data: new Uint8Array([1, 2, 3]),
      contentType: 'application/json',
      capturedAt: null,
      retentionDays: -1,
      detail: {},
    })
    const materialSha = (
      await adminPool.db
        .select({ sha256: t.evidence.sha256 })
        .from(t.evidence)
        .where(eq(t.evidence.evidenceId, evidenceId))
    )[0]?.sha256
    if (materialSha === undefined) throw new Error('evidence row missing')

    const subject = await createSubject(adminPool.db, tenant)
    const validationId = await createValidation(adminPool.db, tenant, subject)
    const claimId = randomUUID()
    await adminPool.db.insert(t.claim).values({
      claimId,
      tenantId: tenant,
      validationId,
      subjectId: subject,
      type: 'address_exists',
      subjectType: 'organization',
      targetType: 'address',
    })

    const claimEvidenceId = randomUUID()
    await adminPool.db.insert(t.claimEvidence).values({
      claimEvidenceId,
      tenantId: tenant,
      claimId,
      evidenceId,
      evidenceSha256: materialSha,
      checker: 'vlm_streetview',
      checkerVersion: '1.0.0',
      stance: 'supports',
      strength: 0.8,
      confidence: 0.9,
      source: 'test',
      observedAt: new Date(),
      ttlSeconds: 3600,
      expiresAt: new Date(Date.now() + 3_600_000),
      detail: {},
    })

    const signalId = randomUUID()
    await adminPool.db.insert(t.signal).values({
      signalId,
      validationId,
      checkerId: 'vlm_streetview',
      checkerVersion: '1.0.0',
      stance: 'supports',
      strength: 0.8,
      confidence: 0.9,
      source: 'test',
      observedAt: new Date(),
      ttlSeconds: 3600,
      detail: {},
      evidenceId,
    })

    const removed = await retentionTick(adminPool.db, store)
    expect(removed).toBeGreaterThanOrEqual(1)

    // O histórico da observação permanece, mas sem ponteiro para o material.
    const evidenceRows = await adminPool.db
      .select({
        evidenceId: t.claimEvidence.evidenceId,
        evidenceSha256: t.claimEvidence.evidenceSha256,
      })
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimEvidenceId, claimEvidenceId))
    expect(evidenceRows.length).toBe(1)
    expect(evidenceRows[0]?.evidenceId).toBeNull()
    // V-3: o digest durável NÃO é apagado pela retenção.
    expect(evidenceRows[0]?.evidenceSha256).toEqual(materialSha)

    const signalRows = await adminPool.db
      .select({ evidenceId: t.signal.evidenceId })
      .from(t.signal)
      .where(eq(t.signal.signalId, signalId))
    expect(signalRows[0]?.evidenceId).toBeNull()

    // O artefato material foi removido.
    expect(
      (await adminPool.db.select().from(t.evidence).where(eq(t.evidence.evidenceId, evidenceId))).length,
    ).toBe(0)
  })
})

// F0.1/ADR-0035: o artefato físico tenant-scoped é apagado do object storage
// ANTES da linha; a linha precisa sair antes de claim_evidence (FK RESTRICT).
describe('retention de evidence_artifact (F0.1)', () => {
  it('remove objeto e linha do artefato ao expirar a validation', async () => {
    const subject = await createSubject(adminPool.db, tenant)
    const validationId = await createValidation(adminPool.db, tenant, subject)
    await adminPool.db
      .update(t.validation)
      .set({ expiresAt: new Date(Date.now() - 86_400_000) })
      .where(eq(t.validation.validationId, validationId))

    const claimId = randomUUID()
    await adminPool.db.insert(t.claim).values({
      claimId,
      tenantId: tenant,
      validationId,
      subjectId: subject,
      type: 'address_exists',
      subjectType: 'organization',
      targetType: 'address',
    })

    const claimEvidenceId = randomUUID()
    await adminPool.db.insert(t.claimEvidence).values({
      claimEvidenceId,
      tenantId: tenant,
      claimId,
      checker: 'document_integrity',
      checkerVersion: '1.0.0',
      stance: 'supports',
      strength: 0.5,
      confidence: 1,
      source: 'test',
      observedAt: new Date(),
      ttlSeconds: 3600,
      expiresAt: new Date(Date.now() + 3_600_000),
      detail: {},
    })

    const artifactId = randomUUID()
    const storageKey = `tenants/${tenant}/evidence/${artifactId}`
    await adminPool.db.insert(t.evidenceArtifact).values({
      artifactId,
      tenantId: tenant,
      claimEvidenceId,
      storageKey,
      contentType: 'application/pdf',
      sizeBytes: 3,
      sha256: randomBytes(32),
      retentionUntil: new Date(Date.now() + 86_400_000),
    })

    const deletedKeys: string[] = []
    const base = makeFakeObjectStore()
    const store: ObjectStore = {
      put: base.put,
      delete: async (key) => {
        deletedKeys.push(key)
        await base.delete(key)
      },
    }

    const removed = await validationRetentionTick(adminPool.db, store)
    expect(removed).toBeGreaterThanOrEqual(1)

    // O objeto foi removido antes do grafo.
    expect(deletedKeys).toContain(storageKey)

    expect(
      (
        await adminPool.db
          .select()
          .from(t.evidenceArtifact)
          .where(eq(t.evidenceArtifact.artifactId, artifactId))
      ).length,
    ).toBe(0)
    expect(
      (
        await adminPool.db
          .select()
          .from(t.claimEvidence)
          .where(eq(t.claimEvidence.claimEvidenceId, claimEvidenceId))
      ).length,
    ).toBe(0)

    // Auditoria da remoção inclui a contagem de artefatos.
    const audits = await adminPool.db
      .select({ details: t.auditLog.details })
      .from(t.auditLog)
      .where(eq(t.auditLog.action, 'validation.expired'))
    expect(audits.some((row) => row.details.artifacts_removed === 1)).toBe(true)
  })
})

describe('retention isolada por validation', () => {
  it('não bloqueia outras validations quando o storage falha e mantém a falha para retry', async () => {
    const retryTenant = await createTenant(adminPool.db, { name: 'ret-tenant-retry' })
    const subject = await createSubject(adminPool.db, retryTenant)
    const failedValidation = await createValidation(adminPool.db, retryTenant, subject)
    const successfulValidation = await createValidation(adminPool.db, retryTenant, subject)
    const expiredAt = new Date(Date.now() - 86_400_000)

    for (const validationId of [failedValidation, successfulValidation]) {
      await adminPool.db
        .update(t.validation)
        .set({ expiresAt: expiredAt })
        .where(eq(t.validation.validationId, validationId))
    }

    const claimId = randomUUID()
    await adminPool.db.insert(t.claim).values({
      claimId,
      tenantId: retryTenant,
      validationId: failedValidation,
      subjectId: subject,
      type: 'address_exists',
      subjectType: 'organization',
      targetType: 'address',
    })

    const claimEvidenceId = randomUUID()
    await adminPool.db.insert(t.claimEvidence).values({
      claimEvidenceId,
      tenantId: retryTenant,
      claimId,
      checker: 'document_integrity',
      checkerVersion: '1.0.0',
      stance: 'supports',
      strength: 0.5,
      confidence: 1,
      source: 'test',
      observedAt: new Date(),
      ttlSeconds: 3600,
      expiresAt: new Date(Date.now() + 3_600_000),
      detail: {},
    })

    const artifactId = randomUUID()
    const storageKey = `tenants/${retryTenant}/evidence/${artifactId}`
    await adminPool.db.insert(t.evidenceArtifact).values({
      artifactId,
      tenantId: retryTenant,
      claimEvidenceId,
      storageKey,
      contentType: 'application/pdf',
      sizeBytes: 3,
      sha256: randomBytes(32),
      retentionUntil: new Date(Date.now() + 86_400_000),
    })

    const base = makeFakeObjectStore()
    const failingStore: ObjectStore = {
      put: base.put,
      delete: async (key) => {
        if (key === storageKey) throw new Error('storage unavailable')
        await base.delete(key)
      },
    }
    const logs: string[] = []
    const logger = createLogger({
      level: 'warn',
      stream: { write: (line) => logs.push(line) },
    })

    const removed = await validationRetentionTick(adminPool.db, failingStore, 200, logger)
    expect(removed).toBe(1)

    // A validation sem artefato foi removida; a que falhou no storage continua
    // viva e elegível para o próximo tick.
    expect(
      (
        await adminPool.db
          .select()
          .from(t.validation)
          .where(eq(t.validation.validationId, successfulValidation))
      ).length,
    ).toBe(0)
    expect(
      (await adminPool.db.select().from(t.validation).where(eq(t.validation.validationId, failedValidation)))
        .length,
    ).toBe(1)
    expect(
      (
        await adminPool.db
          .select()
          .from(t.evidenceArtifact)
          .where(eq(t.evidenceArtifact.artifactId, artifactId))
      ).length,
    ).toBe(1)

    const audits = await adminPool.db
      .select({ details: t.auditLog.details })
      .from(t.auditLog)
      .where(eq(t.auditLog.tenantId, retryTenant))
    expect(audits).toHaveLength(1)
    expect(audits[0]?.details.removed).toBe(1)
    expect(logs.join('\n')).toContain(failedValidation)
    expect(logs.join('\n')).toContain('RETENTION_DELETE_FAILED')

    // Com o storage recuperado, o próximo tick remove a validação que falhou.
    const retried = await validationRetentionTick(adminPool.db, base, 200, logger)
    expect(retried).toBe(1)
    expect(
      (await adminPool.db.select().from(t.validation).where(eq(t.validation.validationId, failedValidation)))
        .length,
    ).toBe(0)
    expect(
      (
        await adminPool.db
          .select()
          .from(t.evidenceArtifact)
          .where(eq(t.evidenceArtifact.artifactId, artifactId))
      ).length,
    ).toBe(0)
  })
})
