import {
  createTenant,
  createSubject,
  createValidation,
  startTestDb,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import { and, createDbPool, eq, inArray, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import { createLogger } from '@comprova/observability'
import { makeFakeObjectStore, sha256Of, type ObjectStore } from '@comprova/providers'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { validationRetentionTick } from './retention.service.js'
import { makeEvidenceWriter } from '../evidence/evidence.service.js'
import { retentionTick } from '../evidence/evidence-retention.service.js'
import { holderSubmissionProcessingTick } from '../holder-submission-processing/holder-submission-processing.service.js'
import {
  EvidenceIntakeError,
  uploadEvidence,
} from '../../../../api/src/modules/validations/evidence-intake.service.js'

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
    const logText = logs.join('\n')
    expect(logText).toContain('"validation_id"')
    expect(logText).toContain('RETENTION_DELETE_FAILED')

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

// PR #73 (revisão): o documento do Holder vinculado à Validation (via
// `evidence_artifact_claim_evidence` + `validation_customer_document`) precisa
// sair junto com o grafo da validation. Sem isso o artefato ficava órfão.
describe('retention do documento do Holder vinculado à Validation (PR #73)', () => {
  it('remove artefato do Holder, associação e vínculo ao expirar a validation', async () => {
    const holderTenant = await createTenant(adminPool.db, { name: 'ret-holder-tenant' })
    const subject = await createSubject(adminPool.db, holderTenant)
    const validationId = await createValidation(adminPool.db, holderTenant, subject)
    await adminPool.db
      .update(t.validation)
      .set({ expiresAt: new Date(Date.now() - 86_400_000) })
      .where(eq(t.validation.validationId, validationId))

    const claimId = randomUUID()
    await adminPool.db.insert(t.claim).values({
      claimId,
      tenantId: holderTenant,
      validationId,
      subjectId: subject,
      type: 'business_registered_address',
      subjectType: 'organization',
      targetType: 'address',
    })

    const receiptId = randomUUID()
    await adminPool.db.insert(t.claimEvidence).values({
      claimEvidenceId: receiptId,
      tenantId: holderTenant,
      claimId,
      checker: 'customer_document_intake',
      checkerVersion: '1.0.0',
      stance: 'unknown',
      strength: 0,
      confidence: 0,
      source: 'customer_submitted_document',
      observedAt: new Date(),
      ttlSeconds: 3600,
      expiresAt: new Date(Date.now() + 3_600_000),
      detail: {},
    })

    await adminPool.db.insert(t.validationCustomerDocument).values({
      validationId,
      claimEvidenceId: receiptId,
      tenantId: holderTenant,
    })

    const holderId = randomUUID()
    await adminPool.db.insert(t.holder).values({
      holderId,
      tenantId: holderTenant,
      externalReference: `holder-${holderId}`,
      name: 'Holder Retencao',
      documentHash: `hash-${holderId}`,
      documentType: 'CPF',
    })
    const requestId = randomUUID()
    await adminPool.db.insert(t.holderInformationRequest).values({
      id: requestId,
      tenantId: holderTenant,
      holderId,
      type: 'documento_complementar',
      purpose: 'Comprovante de residência',
      items: [],
      state: 'completed',
      createdBy: 'retention-test',
      validationId,
    })

    const artifactId = randomUUID()
    const storageKey = `tenants/${holderTenant}/holder-requests/${requestId}/${artifactId}`
    await adminPool.db.insert(t.evidenceArtifact).values({
      artifactId,
      tenantId: holderTenant,
      claimEvidenceId: null,
      holderInformationRequestId: requestId,
      storageKey,
      contentType: 'application/pdf',
      sizeBytes: 3,
      sha256: randomBytes(32),
      retentionUntil: new Date(Date.now() + 86_400_000),
    })
    await adminPool.db.insert(t.evidenceArtifactClaimEvidence).values({
      artifactId,
      claimEvidenceId: receiptId,
      tenantId: holderTenant,
    })

    const deletedKeys: string[] = []
    const base = makeFakeObjectStore()
    await base.put(storageKey, new Uint8Array([1, 2, 3]), 'application/pdf')
    const store: ObjectStore = {
      put: base.put,
      delete: async (key) => {
        deletedKeys.push(key)
        await base.delete(key)
      },
    }

    const removed = await validationRetentionTick(adminPool.db, store)
    expect(removed).toBeGreaterThanOrEqual(1)

    // O objeto do Holder sai antes da linha.
    expect(deletedKeys).toContain(storageKey)

    expect(
      (
        await adminPool.db
          .select({ artifactId: t.evidenceArtifact.artifactId })
          .from(t.evidenceArtifact)
          .where(eq(t.evidenceArtifact.artifactId, artifactId))
      ).length,
    ).toBe(0)
    expect(
      (
        await adminPool.db
          .select({ artifactId: t.evidenceArtifactClaimEvidence.artifactId })
          .from(t.evidenceArtifactClaimEvidence)
          .where(eq(t.evidenceArtifactClaimEvidence.artifactId, artifactId))
      ).length,
    ).toBe(0)
    expect(
      (
        await adminPool.db
          .select({ validationId: t.validationCustomerDocument.validationId })
          .from(t.validationCustomerDocument)
          .where(eq(t.validationCustomerDocument.validationId, validationId))
      ).length,
    ).toBe(0)
    expect(
      (
        await adminPool.db
          .select({ claimEvidenceId: t.claimEvidence.claimEvidenceId })
          .from(t.claimEvidence)
          .where(eq(t.claimEvidence.claimEvidenceId, receiptId))
      ).length,
    ).toBe(0)

    // Auditoria contabiliza o artefato do Holder junto com os demais.
    const audits = await adminPool.db
      .select({ details: t.auditLog.details })
      .from(t.auditLog)
      .where(eq(t.auditLog.action, 'validation.expired'))
    expect(audits.some((row) => row.details.artifacts_removed === 1)).toBe(true)
  })
})

// =====================================================================
// P1 (revisão): artefato do Holder vinculado APENAS ao request — sem
// associação com claim_evidence — também sai com o grafo da validation.
// =====================================================================
const pastDate = (): Date => new Date(Date.now() - 86_400_000)

const seedHolderRequestWithArtifact = async (
  tenantId: string,
  validationId: string,
): Promise<{ requestId: string; artifactId: string; storageKey: string }> => {
  const holderId = randomUUID()
  await adminPool.db.insert(t.holder).values({
    holderId,
    tenantId,
    externalReference: `holder-${holderId}`,
    name: 'Holder Retencao',
    documentHash: `hash-${holderId}`,
    documentType: 'CPF',
  })
  const requestId = randomUUID()
  await adminPool.db.insert(t.holderInformationRequest).values({
    id: requestId,
    tenantId,
    holderId,
    type: 'documento_complementar',
    purpose: 'Comprovante de residência',
    items: [],
    state: 'completed',
    createdBy: 'retention-test',
    validationId,
  })
  const artifactId = randomUUID()
  const storageKey = `tenants/${tenantId}/holder-requests/${requestId}/${artifactId}`
  await adminPool.db.insert(t.evidenceArtifact).values({
    artifactId,
    tenantId,
    claimEvidenceId: null,
    holderInformationRequestId: requestId,
    storageKey,
    contentType: 'application/pdf',
    sizeBytes: 3,
    sha256: randomBytes(32),
    retentionUntil: new Date(Date.now() + 86_400_000),
  })
  return { requestId, artifactId, storageKey }
}

const trackingStore = (): {
  store: ObjectStore & { get: (key: string) => Promise<Uint8Array | null> }
  deletedKeys: string[]
} => {
  const deletedKeys: string[] = []
  const base = makeFakeObjectStore()
  return {
    deletedKeys,
    store: {
      put: base.put,
      get: base.get,
      delete: async (key) => {
        deletedKeys.push(key)
        await base.delete(key)
      },
    },
  }
}

describe('retention de artefato do Holder sem associação (P1 revisão)', () => {
  it('remove objeto e linha do artefato vinculado apenas ao request, sem afetar outra validation ou tenant', async () => {
    const tenantA = await createTenant(adminPool.db, { name: 'ret-holder-unlinked' })
    const subjectA = await createSubject(adminPool.db, tenantA)
    const expiredValidation = await createValidation(adminPool.db, tenantA, subjectA)
    await adminPool.db
      .update(t.validation)
      .set({ expiresAt: pastDate() })
      .where(eq(t.validation.validationId, expiredValidation))
    const target = await seedHolderRequestWithArtifact(tenantA, expiredValidation)

    // Outra validation do MESMO tenant (vigente) com request + artefato.
    const otherValidation = await createValidation(adminPool.db, tenantA, subjectA)
    const sameTenantOther = await seedHolderRequestWithArtifact(tenantA, otherValidation)

    // Outro tenant com validation vigente + request + artefato.
    const tenantB = await createTenant(adminPool.db, { name: 'ret-holder-unlinked-b' })
    const subjectB = await createSubject(adminPool.db, tenantB)
    const validationB = await createValidation(adminPool.db, tenantB, subjectB)
    const otherTenant = await seedHolderRequestWithArtifact(tenantB, validationB)

    const { store, deletedKeys } = trackingStore()
    const removed = await validationRetentionTick(adminPool.db, store)
    expect(removed).toBeGreaterThanOrEqual(1)

    // O artefato sem associação foi descoberto pela validation e removido.
    expect(deletedKeys).toContain(target.storageKey)
    expect(
      (
        await adminPool.db
          .select({ artifactId: t.evidenceArtifact.artifactId })
          .from(t.evidenceArtifact)
          .where(eq(t.evidenceArtifact.artifactId, target.artifactId))
      ).length,
    ).toBe(0)

    // Isolamento: nada de outra validation ou de outro tenant foi tocado.
    expect(deletedKeys).not.toContain(sameTenantOther.storageKey)
    expect(deletedKeys).not.toContain(otherTenant.storageKey)
    for (const untouched of [sameTenantOther, otherTenant]) {
      expect(
        (
          await adminPool.db
            .select({ artifactId: t.evidenceArtifact.artifactId })
            .from(t.evidenceArtifact)
            .where(eq(t.evidenceArtifact.artifactId, untouched.artifactId))
        ).length,
      ).toBe(1)
    }

    // O vínculo da request com a validation expirada é limpo (mesmo padrão da
    // erasure do subject), preservando a request no domínio do Holder.
    const [requestRow] = await adminPool.db
      .select({ validationId: t.holderInformationRequest.validationId })
      .from(t.holderInformationRequest)
      .where(eq(t.holderInformationRequest.id, target.requestId))
    expect(requestRow?.validationId).toBeNull()
  })
})

// =====================================================================
// Protocolo de lock: criação/associação (F1.1, worker, API) e retenção
// travam a MESMA linha da validation antes de tocar o grafo.
// =====================================================================
const pdf = (): Buffer => {
  const content = 'BT /F1 12 Tf 72 720 Td (COMPROVANTE) Tj ET'
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'latin1'),
    Buffer.from(
      `1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R /Size 2 >>\nstartxref\n0\n%%EOF\n${content}\n`,
      'latin1',
    ),
  ])
}

const silentLogger = createLogger({ level: 'silent' })

const seedHolderSubmission = async (
  tenantId: string,
  validationId: string | null,
): Promise<{
  requestId: string
  storageKey: string
  documentId: string
  itemId: string
  contentType: string
  sizeBytes: number
  sha256: Buffer
}> => {
  const holderId = randomUUID()
  await adminPool.db.insert(t.holder).values({
    holderId,
    tenantId,
    externalReference: `holder-${holderId}`,
    name: 'Holder Concorrencia',
    documentHash: `hash-${holderId}`,
    documentType: 'CPF',
  })
  const requestId = randomUUID()
  await adminPool.db.insert(t.holderInformationRequest).values({
    id: requestId,
    tenantId,
    holderId,
    type: 'documento_complementar',
    purpose: 'Comprovante de residência',
    items: [],
    state: 'completed',
    createdBy: 'retention-test',
    validationId,
  })
  const documentId = randomUUID()
  const storageKey = `tenants/${tenantId}/holder-requests/${requestId}/${documentId}`
  const sha256 = sha256Of(pdf())
  await adminPool.db.insert(t.holderInformationRequestDocument).values({
    documentId,
    tenantId,
    holderInformationRequestId: requestId,
    itemId: 'address-proof-0',
    uploadState: 'stored',
    storageKey,
    contentType: 'application/pdf',
    sizeBytes: 3,
    sha256,
    originalFilename: 'comprovante.pdf',
  })
  await adminPool.db.insert(t.outbox).values({
    aggregate: 'holder_information_request',
    aggregateId: requestId,
    eventType: 'holder_submission.processing_requested',
    payload: {
      holder_information_request_id: requestId,
      tenant_id: tenantId,
    },
  })
  return {
    requestId,
    storageKey,
    documentId,
    itemId: 'address-proof-0',
    contentType: 'application/pdf',
    sizeBytes: 3,
    sha256,
  }
}

const graphRowsFor = async (tenantId: string, validationId: string) => {
  const claims = await adminPool.db
    .select({ claimId: t.claim.claimId })
    .from(t.claim)
    .where(and(eq(t.claim.validationId, validationId), eq(t.claim.tenantId, tenantId)))
  const claimIds = claims.map((claim) => claim.claimId)
  const receipts =
    claimIds.length === 0
      ? []
      : await adminPool.db
          .select({ claimEvidenceId: t.claimEvidence.claimEvidenceId })
          .from(t.claimEvidence)
          .where(
            and(
              inArray(t.claimEvidence.claimId, claimIds),
              eq(t.claimEvidence.source, 'customer_submitted_document'),
            ),
          )
  const receiptIds = receipts.map((row) => row.claimEvidenceId)
  const associations =
    receiptIds.length === 0
      ? []
      : await adminPool.db
          .select()
          .from(t.evidenceArtifactClaimEvidence)
          .where(inArray(t.evidenceArtifactClaimEvidence.claimEvidenceId, receiptIds))
  const links = await adminPool.db
    .select()
    .from(t.validationCustomerDocument)
    .where(
      and(
        eq(t.validationCustomerDocument.validationId, validationId),
        eq(t.validationCustomerDocument.tenantId, tenantId),
      ),
    )
  return { claims, receipts, associations, links }
}

describe('protocolo de lock: retenção × criação/associação (P1 revisão)', () => {
  it('Cenário A: retenção concorrente com materialização do worker não deixa órfãos nem associações', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'ret-lock-worker' })
    const subjectId = await createSubject(adminPool.db, tenantId)
    const validationId = await createValidation(adminPool.db, tenantId, subjectId)
    await adminPool.db
      .update(t.validation)
      .set({ expiresAt: pastDate() })
      .where(eq(t.validation.validationId, validationId))

    // Artefato pré-existente, vinculado apenas ao request (classe P1).
    const preExisting = await seedHolderRequestWithArtifact(tenantId, validationId)
    // Submissão pendente: o worker pode materializar artefato/associação.
    const submission = await seedHolderSubmission(tenantId, validationId)

    const { store, deletedKeys } = trackingStore()
    const [retention, worker] = await Promise.allSettled([
      validationRetentionTick(adminPool.db, store, 200),
      holderSubmissionProcessingTick({ db: adminPool.db, store, logger: silentLogger }),
    ])
    expect(retention.status).toBe('fulfilled')
    expect(worker.status).toBe('fulfilled')

    // A validation foi removida em qualquer ordem de vencedor.
    expect(
      (
        await adminPool.db
          .select({ validationId: t.validation.validationId })
          .from(t.validation)
          .where(eq(t.validation.validationId, validationId))
      ).length,
    ).toBe(0)

    // Nenhuma sobra do grafo: claims, recibos, associações e vínculos.
    const graph = await graphRowsFor(tenantId, validationId)
    expect(graph.claims).toHaveLength(0)
    expect(graph.receipts).toHaveLength(0)
    expect(graph.associations).toHaveLength(0)
    expect(graph.links).toHaveLength(0)

    // O artefato pré-existente saiu do storage e do banco.
    expect(deletedKeys).toContain(preExisting.storageKey)
    expect(
      (
        await adminPool.db
          .select({ artifactId: t.evidenceArtifact.artifactId })
          .from(t.evidenceArtifact)
          .where(eq(t.evidenceArtifact.artifactId, preExisting.artifactId))
      ).length,
    ).toBe(0)

    // Qualquer artefato remanescente da request é holder-domain puro: sem
    // claim_evidence, sem associação e com o vínculo da request limpo.
    const remaining = await adminPool.db
      .select()
      .from(t.evidenceArtifact)
      .where(eq(t.evidenceArtifact.holderInformationRequestId, submission.requestId))
    for (const artifact of remaining) {
      expect(artifact.claimEvidenceId).toBeNull()
      expect(
        (
          await adminPool.db
            .select({ artifactId: t.evidenceArtifactClaimEvidence.artifactId })
            .from(t.evidenceArtifactClaimEvidence)
            .where(eq(t.evidenceArtifactClaimEvidence.artifactId, artifact.artifactId))
        ).length,
      ).toBe(0)
    }
    const [requestRow] = await adminPool.db
      .select({ validationId: t.holderInformationRequest.validationId })
      .from(t.holderInformationRequest)
      .where(eq(t.holderInformationRequest.id, submission.requestId))
    expect(requestRow?.validationId).toBeNull()
  })

  it('Cenário B: upload F1.1 concorrente com a retenção é rejeitado e não insere artefato', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'ret-lock-upload' })
    const subjectId = await createSubject(adminPool.db, tenantId)
    const validationId = await createValidation(adminPool.db, tenantId, subjectId)
    await adminPool.db
      .update(t.validation)
      .set({ expiresAt: pastDate() })
      .where(eq(t.validation.validationId, validationId))

    const { store, deletedKeys } = trackingStore()
    const [retention, upload] = await Promise.allSettled([
      validationRetentionTick(adminPool.db, store, 200),
      uploadEvidence(
        { db: adminPool.db, store, logger: silentLogger, maxBytes: 64 * 1024 },
        {
          tenantId,
          validationId,
          data: new Uint8Array(pdf()),
          declaredContentType: 'application/pdf',
          idempotencyKey: undefined,
        },
      ),
    ])
    expect(retention.status).toBe('fulfilled')
    expect(upload.status).toBe('rejected')
    const reason = (upload as PromiseRejectedResult).reason
    expect(reason).toBeInstanceOf(EvidenceIntakeError)
    expect((reason as EvidenceIntakeError).problem.status).toBe(404)

    // A validation foi removida e nada foi persistido: sem claim, recibo,
    // artefato, associação ou vínculo; o storage não ganhou objeto novo.
    expect(
      (
        await adminPool.db
          .select({ validationId: t.validation.validationId })
          .from(t.validation)
          .where(eq(t.validation.validationId, validationId))
      ).length,
    ).toBe(0)
    const graph = await graphRowsFor(tenantId, validationId)
    expect(graph.claims).toHaveLength(0)
    expect(graph.receipts).toHaveLength(0)
    expect(graph.associations).toHaveLength(0)
    expect(graph.links).toHaveLength(0)
    expect(
      (
        await adminPool.db
          .select({ artifactId: t.evidenceArtifact.artifactId })
          .from(t.evidenceArtifact)
          .where(eq(t.evidenceArtifact.tenantId, tenantId))
      ).length,
    ).toBe(0)
    expect(deletedKeys).toHaveLength(0)
  })

  it('Cenário C: submissão para Validation expirada não persiste artefato, recibo nem associação', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'ret-expired-worker' })
    const subjectId = await createSubject(adminPool.db, tenantId)
    const validationId = await createValidation(adminPool.db, tenantId, subjectId)
    await adminPool.db
      .update(t.validation)
      .set({ expiresAt: pastDate() })
      .where(eq(t.validation.validationId, validationId))
    const submission = await seedHolderSubmission(tenantId, validationId)

    const processed = await holderSubmissionProcessingTick({
      db: adminPool.db,
      store: makeFakeObjectStore(),
      logger: silentLogger,
    })
    expect(processed).toBe(1)

    // Nada materializado para a validation expirada.
    expect(
      (
        await adminPool.db
          .select({ artifactId: t.evidenceArtifact.artifactId })
          .from(t.evidenceArtifact)
          .where(eq(t.evidenceArtifact.holderInformationRequestId, submission.requestId))
      ).length,
    ).toBe(0)
    const graph = await graphRowsFor(tenantId, validationId)
    expect(graph.claims).toHaveLength(0)
    expect(graph.receipts).toHaveLength(0)
    expect(graph.associations).toHaveLength(0)
    expect(graph.links).toHaveLength(0)
    expect(
      (
        await adminPool.db
          .select({ artifactId: t.evidenceArtifactClaimEvidence.artifactId })
          .from(t.evidenceArtifactClaimEvidence)
          .where(eq(t.evidenceArtifactClaimEvidence.tenantId, tenantId))
      ).length,
    ).toBe(0)

    // O evento é consumido (terminal), sem criar trabalho para a retention.
    const [outboxRow] = await adminPool.db
      .select({ publishedAt: t.outbox.publishedAt })
      .from(t.outbox)
      .where(eq(t.outbox.aggregateId, submission.requestId))
    expect(outboxRow?.publishedAt).not.toBeNull()
    const [processingRow] = await adminPool.db
      .select({ state: t.holderSubmissionProcessing.state })
      .from(t.holderSubmissionProcessing)
      .where(eq(t.holderSubmissionProcessing.holderInformationRequestId, submission.requestId))
    expect(processingRow?.state).toBe('processed')
  })

  it('Cenário C: upload F1.1 em Validation expirada responde 404 sem persistir nada', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'ret-expired-upload' })
    const subjectId = await createSubject(adminPool.db, tenantId)
    const validationId = await createValidation(adminPool.db, tenantId, subjectId)
    await adminPool.db
      .update(t.validation)
      .set({ expiresAt: pastDate() })
      .where(eq(t.validation.validationId, validationId))

    let caught: unknown = null
    try {
      await uploadEvidence(
        { db: adminPool.db, store: makeFakeObjectStore(), logger: silentLogger, maxBytes: 64 * 1024 },
        {
          tenantId,
          validationId,
          data: new Uint8Array(pdf()),
          declaredContentType: 'application/pdf',
          idempotencyKey: undefined,
        },
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(EvidenceIntakeError)
    expect((caught as EvidenceIntakeError).problem.status).toBe(404)

    // Nada persistido: sem claim, recibo, artefato ou associação no tenant.
    const graph = await graphRowsFor(tenantId, validationId)
    expect(graph.claims).toHaveLength(0)
    expect(graph.receipts).toHaveLength(0)
    expect(graph.associations).toHaveLength(0)
    expect(graph.links).toHaveLength(0)
    expect(
      (
        await adminPool.db
          .select({ artifactId: t.evidenceArtifact.artifactId })
          .from(t.evidenceArtifact)
          .where(eq(t.evidenceArtifact.tenantId, tenantId))
      ).length,
    ).toBe(0)
  })
})

// =====================================================================
// Rodada 3 — documentos ORIGINAIS do Holder na retenção (P1).
// =====================================================================
describe('retention dos documentos originais do Holder sem evidence_artifact (P1 r3)', () => {
  it('Caso A: documento sem evidence_artifact é removido do storage e tombstoned', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'ret-doc-no-artifact' })
    const subjectId = await createSubject(adminPool.db, tenantId)
    const validationId = await createValidation(adminPool.db, tenantId, subjectId)
    await adminPool.db
      .update(t.validation)
      .set({ expiresAt: pastDate() })
      .where(eq(t.validation.validationId, validationId))
    // Upload F4.2 completo, ainda NÃO materializado como evidence_artifact.
    const submission = await seedHolderSubmission(tenantId, validationId)

    const { store, deletedKeys } = trackingStore()
    const removed = await validationRetentionTick(adminPool.db, store)
    expect(removed).toBeGreaterThanOrEqual(1)

    // O objeto original saiu do storage.
    expect(deletedKeys).toContain(submission.storageKey)

    // O registro permanece com o tombstone explícito do modelo F4.2 —
    // "Documento recebido = stored && deletedAt IS NULL" deixa de valer.
    const [docRow] = await adminPool.db
      .select({
        deletedAt: t.holderInformationRequestDocument.deletedAt,
        uploadState: t.holderInformationRequestDocument.uploadState,
      })
      .from(t.holderInformationRequestDocument)
      .where(eq(t.holderInformationRequestDocument.documentId, submission.documentId))
    expect(docRow?.uploadState).toBe('stored')
    expect(docRow?.deletedAt).not.toBeNull()

    // A validação saiu e a request foi desvinculada.
    expect(
      (
        await adminPool.db
          .select({ validationId: t.validation.validationId })
          .from(t.validation)
          .where(eq(t.validation.validationId, validationId))
      ).length,
    ).toBe(0)
    const [requestRow] = await adminPool.db
      .select({ validationId: t.holderInformationRequest.validationId })
      .from(t.holderInformationRequest)
      .where(eq(t.holderInformationRequest.id, submission.requestId))
    expect(requestRow?.validationId).toBeNull()

    // Auditoria registra os documentos removidos.
    const audits = await adminPool.db
      .select({ details: t.auditLog.details })
      .from(t.auditLog)
      .where(eq(t.auditLog.action, 'validation.expired'))
    expect(audits.some((row) => row.details.documents_removed === 1)).toBe(true)
  })

  it('Caso B: documento com evidence_artifact — objeto sai uma única vez e ambos os registros são tratados', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'ret-doc-with-artifact' })
    const subjectId = await createSubject(adminPool.db, tenantId)
    const validationId = await createValidation(adminPool.db, tenantId, subjectId)
    await adminPool.db
      .update(t.validation)
      .set({ expiresAt: pastDate() })
      .where(eq(t.validation.validationId, validationId))
    const submission = await seedHolderSubmission(tenantId, validationId)

    // Artefato do Holder compartilha o MESMO storage_key do documento (F4.2/F4.3).
    const artifactId = randomUUID()
    await adminPool.db.insert(t.evidenceArtifact).values({
      artifactId,
      tenantId,
      claimEvidenceId: null,
      holderInformationRequestId: submission.requestId,
      storageKey: submission.storageKey,
      contentType: submission.contentType,
      sizeBytes: submission.sizeBytes,
      sha256: submission.sha256,
      retentionUntil: new Date(Date.now() + 86_400_000),
    })

    const { store, deletedKeys } = trackingStore()
    await validationRetentionTick(adminPool.db, store)

    // Mesma chave aparece EXATAMENTE uma vez (dedupe artefato × documento).
    expect(deletedKeys.filter((key) => key === submission.storageKey)).toHaveLength(1)

    // Linha do artefato removida; documento tombstoned.
    expect(
      (
        await adminPool.db
          .select({ artifactId: t.evidenceArtifact.artifactId })
          .from(t.evidenceArtifact)
          .where(eq(t.evidenceArtifact.artifactId, artifactId))
      ).length,
    ).toBe(0)
    const [docRow] = await adminPool.db
      .select({ deletedAt: t.holderInformationRequestDocument.deletedAt })
      .from(t.holderInformationRequestDocument)
      .where(eq(t.holderInformationRequestDocument.documentId, submission.documentId))
    expect(docRow?.deletedAt).not.toBeNull()
  })

  it('Caso C: falha no storage mantém estado para retry e a nova execução conclui', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'ret-doc-retry' })
    const subjectId = await createSubject(adminPool.db, tenantId)
    const validationId = await createValidation(adminPool.db, tenantId, subjectId)
    await adminPool.db
      .update(t.validation)
      .set({ expiresAt: pastDate() })
      .where(eq(t.validation.validationId, validationId))
    const submission = await seedHolderSubmission(tenantId, validationId)

    const base = makeFakeObjectStore()
    const failingStore: ObjectStore = {
      put: base.put,
      delete: async (key) => {
        if (key === submission.storageKey) throw new Error('storage unavailable')
        await base.delete(key)
      },
    }

    // Primeira execução: delete do objeto falha → transação inteira desfeita.
    await validationRetentionTick(adminPool.db, failingStore)

    // Estado suficiente para retry: validação e documento permanecem ATIVOS
    // (sem tombstone), então o próximo tick redescobre tudo.
    expect(
      (
        await adminPool.db
          .select({ validationId: t.validation.validationId })
          .from(t.validation)
          .where(eq(t.validation.validationId, validationId))
      ).length,
    ).toBe(1)
    const [docRow] = await adminPool.db
      .select({ deletedAt: t.holderInformationRequestDocument.deletedAt })
      .from(t.holderInformationRequestDocument)
      .where(eq(t.holderInformationRequestDocument.documentId, submission.documentId))
    expect(docRow?.deletedAt).toBeNull()

    // Retry com storage recuperado conclui a limpeza.
    const { store, deletedKeys } = trackingStore()
    await validationRetentionTick(adminPool.db, store)
    expect(deletedKeys).toContain(submission.storageKey)
    expect(
      (
        await adminPool.db
          .select({ validationId: t.validation.validationId })
          .from(t.validation)
          .where(eq(t.validation.validationId, validationId))
      ).length,
    ).toBe(0)
    const [docRowAfter] = await adminPool.db
      .select({ deletedAt: t.holderInformationRequestDocument.deletedAt })
      .from(t.holderInformationRequestDocument)
      .where(eq(t.holderInformationRequestDocument.documentId, submission.documentId))
    expect(docRowAfter?.deletedAt).not.toBeNull()
  })
})

// =====================================================================
// Rodada 3 — corrida entre leitura do validation_id e aquisição do lock.
// =====================================================================
describe('corrida validation_id × lock (P1 r3)', () => {
  it('Caso A: validation removida antes do lock — worker falha fechado, sem artefato nem análise', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'ret-race-worker' })
    const subjectId = await createSubject(adminPool.db, tenantId)
    const validationId = await createValidation(adminPool.db, tenantId, subjectId)
    const submission = await seedHolderSubmission(tenantId, validationId)

    // Remoção concorrente da validation (a request fica com ponteiro pendente —
    // a retenção real desvincula na mesma transação; aqui simulamos a janela
    // em que o worker leu o vínculo antes da remoção).
    await adminPool.db.delete(t.validation).where(eq(t.validation.validationId, validationId))

    const processed = await holderSubmissionProcessingTick({
      db: adminPool.db,
      store: makeFakeObjectStore(),
      logger: silentLogger,
    })
    // O tick processa todos os eventos pendentes do arquivo; o que importa
    // aqui é o estado DESTA solicitação, verificado abaixo.
    expect(processed).toBeGreaterThanOrEqual(1)

    // Nenhum artefato novo e nenhuma análise pendente.
    const artifacts = await adminPool.db
      .select({ artifactId: t.evidenceArtifact.artifactId })
      .from(t.evidenceArtifact)
      .where(eq(t.evidenceArtifact.holderInformationRequestId, submission.requestId))
    expect(artifacts).toHaveLength(0)
    expect(
      (
        await adminPool.db
          .select({ analysisId: t.evidenceAnalysis.analysisId })
          .from(t.evidenceAnalysis)
          .where(eq(t.evidenceAnalysis.tenantId, tenantId))
      ).length,
    ).toBe(0)

    // O processamento NÃO é sucesso: estado terminal 'failed' com motivo.
    const [processingRow] = await adminPool.db
      .select({
        state: t.holderSubmissionProcessing.state,
        lastError: t.holderSubmissionProcessing.lastError,
      })
      .from(t.holderSubmissionProcessing)
      .where(eq(t.holderSubmissionProcessing.holderInformationRequestId, submission.requestId))
    expect(processingRow?.state).toBe('failed')
    expect(processingRow?.lastError).toBe('HOLDER_VALIDATION_REMOVED')
  })

  it('Caso A (API): processDocuments com validation removida falha sem inserir artefato', async () => {
    const { makeHolderSubmissionProcessingService } =
      await import('../../../../api/src/modules/holder/holder-submission-processing.service.js')
    const tenantId = await createTenant(adminPool.db, { name: 'ret-race-api' })
    const subjectId = await createSubject(adminPool.db, tenantId)
    const validationId = await createValidation(adminPool.db, tenantId, subjectId)
    const submission = await seedHolderSubmission(tenantId, validationId)
    await adminPool.db.delete(t.validation).where(eq(t.validation.validationId, validationId))

    const processing = makeHolderSubmissionProcessingService({
      db: adminPool.db,
      store: makeFakeObjectStore(),
      logger: silentLogger,
    })
    const result = await adminPool.db.transaction((tx) =>
      processing.processDocuments(tx, tenantId, submission.requestId, [
        {
          documentId: submission.documentId,
          storageKey: submission.storageKey,
          itemId: submission.itemId,
          contentType: submission.contentType,
          sizeBytes: submission.sizeBytes,
          sha256: submission.sha256,
        },
      ]),
    )
    expect(result.processed).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.errors[0]).toContain('VALIDATION_REMOVED')
    expect(
      (
        await adminPool.db
          .select({ artifactId: t.evidenceArtifact.artifactId })
          .from(t.evidenceArtifact)
          .where(eq(t.evidenceArtifact.holderInformationRequestId, submission.requestId))
      ).length,
    ).toBe(0)
  })

  it('Caso B: solicitação originalmente sem validation preserva o fluxo F4.3 com retenção de 30 dias', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'ret-race-unlinked' })
    const submission = await seedHolderSubmission(tenantId, null)

    const processed = await holderSubmissionProcessingTick({
      db: adminPool.db,
      store: makeFakeObjectStore(),
      logger: silentLogger,
    })
    expect(processed).toBeGreaterThanOrEqual(1)

    const [artifact] = await adminPool.db
      .select()
      .from(t.evidenceArtifact)
      .where(eq(t.evidenceArtifact.holderInformationRequestId, submission.requestId))
    expect(artifact).toBeDefined()
    expect(artifact!.claimEvidenceId).toBeNull()
    // Política F4.3: retenção independente de ~30 dias, sem validation.
    expect(artifact!.retentionUntil.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000)
    expect(artifact!.retentionUntil.getTime()).toBeLessThanOrEqual(Date.now() + 31 * 86_400_000)
    expect(
      (
        await adminPool.db
          .select({ analysisId: t.evidenceAnalysis.analysisId })
          .from(t.evidenceAnalysis)
          .where(eq(t.evidenceAnalysis.artifactId, artifact!.artifactId))
      ).length,
    ).toBe(1)
    const [processingRow] = await adminPool.db
      .select({ state: t.holderSubmissionProcessing.state })
      .from(t.holderSubmissionProcessing)
      .where(eq(t.holderSubmissionProcessing.holderInformationRequestId, submission.requestId))
    expect(processingRow?.state).toBe('processed')
  })

  it('relógio avança enquanto o lock espera: validation passa a ser tratada como expirada', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'ret-clock' })
    const subjectId = await createSubject(adminPool.db, tenantId)
    const validationId = await createValidation(adminPool.db, tenantId, subjectId)
    const expiresAt = new Date(Date.now() + 86_400_000)
    await adminPool.db
      .update(t.validation)
      .set({ expiresAt })
      .where(eq(t.validation.validationId, validationId))
    await seedHolderSubmission(tenantId, validationId)

    // Relógio inicial ANTES da expiração.
    let clock = new Date(Date.now() + 60_000)
    expect(clock.getTime()).toBeLessThan(expiresAt.getTime())

    let releaseKeeper!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseKeeper = resolve
    })
    const keeper = adminPool.db.transaction(async (tx) => {
      await tx
        .select({ validationId: t.validation.validationId })
        .from(t.validation)
        .where(eq(t.validation.validationId, validationId))
        .for('update')
      await gate
    })

    const tickPromise = holderSubmissionProcessingTick({
      db: adminPool.db,
      store: makeFakeObjectStore(),
      logger: silentLogger,
      now: () => clock,
    })
    // Dá tempo de o tick chegar ao lock da validation e esperar nele.
    await new Promise((resolve) => setTimeout(resolve, 150))
    // O relógio avança para DEPOIS de expiresAt antes de liberar o lock.
    clock = new Date(expiresAt.getTime() + 60_000)
    releaseKeeper()
    await keeper
    await tickPromise

    // Tratada como expirada: nada materializado e a validation permanece
    // (quem a remove é a retenção, não o worker).
    expect(
      (
        await adminPool.db
          .select({ validationId: t.validation.validationId })
          .from(t.validation)
          .where(eq(t.validation.validationId, validationId))
      ).length,
    ).toBe(1)
    expect(
      (
        await adminPool.db
          .select({ artifactId: t.evidenceArtifact.artifactId })
          .from(t.evidenceArtifact)
          .where(eq(t.evidenceArtifact.tenantId, tenantId))
      ).length,
    ).toBe(0)
    expect(
      (
        await adminPool.db
          .select({ artifactId: t.evidenceArtifactClaimEvidence.artifactId })
          .from(t.evidenceArtifactClaimEvidence)
          .where(eq(t.evidenceArtifactClaimEvidence.tenantId, tenantId))
      ).length,
    ).toBe(0)
  })
})
