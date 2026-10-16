import { createTenant, seedGoldenDataset, startTestDb, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import {
  createDbPool,
  eq,
  makeCepReader,
  makeCnaeCategoriaReader,
  makeCnefeReader,
  makeKnownSharedReader,
  makeProfileReader,
  makeRegistryReader,
  runMigrations,
} from '@comprova/db'
import * as t from '@comprova/db'
import { loadPolicy, systemClock } from '@comprova/core'
import { makeT0Checkers, makeT1Checkers } from '@comprova/checkers'
import { makeFakeGeocoder, makeFailingGeocoder, makeFakePlaces, makeFailingPlaces } from '@comprova/providers'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { deepEnrich } from './deep-enrich.js'
import { runFastPath } from '../../api/src/services/fastpath.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
await seedGoldenDataset(adminPool.db)
const tenant = await createTenant(adminPool.db, { name: 'deep-tenant' })

const policy = loadPolicy(readFileSync(path.join(repoRoot, 'policies', '2026.11.1.yaml'), 'utf8'))

afterAll(async () => {
  await adminPool.end()
  await db.stop()
})

const registry = makeRegistryReader(adminPool.db)
const fastPathDeps = {
  db: adminPool.db,
  registry,
  checkers: makeT0Checkers({
    registry,
    cnefe: makeCnefeReader(adminPool.db),
    cep: makeCepReader(adminPool.db),
    profile: makeProfileReader(adminPool.db),
    knownShared: makeKnownSharedReader(adminPool.db),
    cnaeCategoria: makeCnaeCategoriaReader(adminPool.db),
  }),
  policy,
  clock: systemClock,
  docHmacKey: 'test-doc-hmac-key',
}

const t1WithFakes = makeT1Checkers({
  geocoder: makeFakeGeocoder(() => ({
    point: { lat: -23.56, lon: -46.65 },
    precision: 'ROOFTOP' as const,
    label: 'Rua das Flores, 100',
  })),
  cnefeCoords: {
    coordFor: async () => ({ lat: -23.56, lon: -46.65 }),
  },
  places: makeFakePlaces([
    { name: 'Loja das Flores', lat: -23.56, lon: -46.65, categories: ['shop=florist'] },
  ]),
})

const t1Chaos = makeT1Checkers({
  geocoder: makeFailingGeocoder(),
  cnefeCoords: {
    coordFor: async () => null,
  },
  places: makeFailingPlaces(),
})

describe('deepEnrich (activity core)', () => {
  it('enriquece validacao com sinais T1, atualiza veredito e popula cache de endereco', async () => {
    const created = await runFastPath(
      fastPathDeps,
      { tenantId: tenant, apiKeyId: 'test' },
      {
        documentType: 'CNPJ',
        documentValue: '12345678000195',
        addressInput: null,
        legalBasis: 'FRAUD_PREVENTION',
        mode: 'auto',
        idempotencyKey: 'deep-test-1',
      },
    )
    expect(created.verdict).toBe('CONFIRMED_COMMERCIAL')

    const result = await deepEnrich(
      { db: adminPool.db, t1Checkers: t1WithFakes, policy, clock: systemClock },
      { tenantId: tenant, validationId: created.validationId },
    )
    expect(result.status).toBe('completed')
    expect(result.verdict).toBe('CONFIRMED_COMMERCIAL')
    expect(result.newSignals).toBe(3)

    const signals = await adminPool.db
      .select({ checkerId: t.signal.checkerId })
      .from(t.signal)
      .where(eq(t.signal.validationId, created.validationId))
    const ids = signals.map((s) => s.checkerId)
    expect(ids).toContain('geocode_consensus')
    expect(ids).toContain('places_match')
    expect(ids).toContain('digital_footprint')

    const cached = await adminPool.db
      .select({ checkerId: t.addressSignalCache.checkerId })
      .from(t.addressSignalCache)
    expect(cached.length).toBeGreaterThanOrEqual(3)
  })

  it('caos: providers fora do ar degradam para unknown, sem veredito falso', async () => {
    const created = await runFastPath(
      fastPathDeps,
      { tenantId: tenant, apiKeyId: 'test' },
      {
        documentType: 'CNPJ',
        documentValue: '90123456000131',
        addressInput: null,
        legalBasis: 'FRAUD_PREVENTION',
        mode: 'auto',
        idempotencyKey: 'deep-test-2',
      },
    )
    expect(created.verdict).toBe('INSUFFICIENT_EVIDENCE')

    const result = await deepEnrich(
      { db: adminPool.db, t1Checkers: t1Chaos, policy, clock: systemClock },
      { tenantId: tenant, validationId: created.validationId },
    )
    expect(result.status).toBe('partial')
    expect(result.verdict).toBe('INSUFFICIENT_EVIDENCE')
    const t1Signals = await adminPool.db
      .select({ stance: t.signal.stance })
      .from(t.signal)
      .where(eq(t.signal.validationId, created.validationId))
    expect(t1Signals.filter((s) => s.stance === 'contradicts').length).toBe(0)
  })

  // Fase 14 — evidências históricas jamais são sobrescritas: nova observação → nova
  // evidência. Reexecutar o enriquecimento anexa (append-only) e o replay não muta
  // nem duplica linhas existentes.
  it('Fase 14 — claim_evidence é append-only e imutável entre execuções', async () => {
    const created = await runFastPath(
      fastPathDeps,
      { tenantId: tenant, apiKeyId: 'test' },
      {
        documentType: 'CNPJ',
        documentValue: '12345678000195',
        addressInput: null,
        legalBasis: 'FRAUD_PREVENTION',
        mode: 'auto',
        idempotencyKey: 'fase14-immutability',
      },
    )

    const claimRows = await adminPool.db
      .select({ claimId: t.claim.claimId })
      .from(t.claim)
      .where(eq(t.claim.validationId, created.validationId))
    const claimId = claimRows[0]?.claimId
    expect(claimId).toBeDefined()
    if (claimId === undefined) throw new Error('claim nao criado pelo fast path')

    const snapshot = async (): Promise<
      readonly {
        claimEvidenceId: string
        evidenceId: string | null
        signalId: string | null
        checker: string
        checkerVersion: string
        stance: string
        strength: number
        confidence: number
        source: string
        observedAt: Date
        ttlSeconds: number
        detail: Record<string, unknown>
      }[]
    > =>
      adminPool.db
        .select({
          claimEvidenceId: t.claimEvidence.claimEvidenceId,
          evidenceId: t.claimEvidence.evidenceId,
          signalId: t.claimEvidence.signalId,
          checker: t.claimEvidence.checker,
          checkerVersion: t.claimEvidence.checkerVersion,
          stance: t.claimEvidence.stance,
          strength: t.claimEvidence.strength,
          confidence: t.claimEvidence.confidence,
          source: t.claimEvidence.source,
          observedAt: t.claimEvidence.observedAt,
          ttlSeconds: t.claimEvidence.ttlSeconds,
          detail: t.claimEvidence.detail,
        })
        .from(t.claimEvidence)
        .where(eq(t.claimEvidence.claimId, claimId))
        .orderBy(t.claimEvidence.claimEvidenceId)

    const afterFast = await snapshot()
    expect(afterFast.length).toBeGreaterThan(0)

    await deepEnrich(
      { db: adminPool.db, t1Checkers: t1WithFakes, policy, clock: systemClock },
      { tenantId: tenant, validationId: created.validationId },
    )
    const afterFirstDeep = await snapshot()

    // T1 anexou novas evidências (append-only)...
    expect(afterFirstDeep.length).toBeGreaterThan(afterFast.length)
    // ...sem tocar nas evidências do fast path.
    for (const before of afterFast) {
      const after = afterFirstDeep.find((r) => r.claimEvidenceId === before.claimEvidenceId)
      expect(after, `evidence ${before.claimEvidenceId} deve permanecer intacta`).toEqual(before)
    }
    // Nunca há evidência duplicada (ids únicos).
    expect(new Set(afterFirstDeep.map((r) => r.claimEvidenceId)).size).toBe(afterFirstDeep.length)

    // Replay: nova execução não muta nem duplica as evidências já persistidas.
    await deepEnrich(
      { db: adminPool.db, t1Checkers: t1WithFakes, policy, clock: systemClock },
      { tenantId: tenant, validationId: created.validationId },
    )
    const afterReplay = await snapshot()
    expect(afterReplay).toEqual(afterFirstDeep)
  })

  // FASE 7 — validação legada (signals já persistidos, sem claim) recebe claim e
  // claim_evidence para TODOS os seus signals, de forma idempotente.
  it('Fase 7 — cria claim e claim_evidence para validação sem claim (legado)', async () => {
    const created = await runFastPath(
      fastPathDeps,
      { tenantId: tenant, apiKeyId: 'test' },
      {
        documentType: 'CNPJ',
        documentValue: '12345678000195',
        addressInput: null,
        legalBasis: 'FRAUD_PREVENTION',
        mode: 'auto',
        idempotencyKey: 'fase7-legacy',
      },
    )
    const claimRows = await adminPool.db
      .select({ claimId: t.claim.claimId })
      .from(t.claim)
      .where(eq(t.claim.validationId, created.validationId))
    const oldClaimId = claimRows[0]?.claimId
    if (oldClaimId === undefined) throw new Error('claim nao criado pelo fast path')

    // Simula uma validação criada ANTES do modelo claim.
    await adminPool.db.delete(t.claimEvidence).where(eq(t.claimEvidence.claimId, oldClaimId))
    await adminPool.db.delete(t.claim).where(eq(t.claim.claimId, oldClaimId))

    const prior = await adminPool.db
      .select({ signalId: t.signal.signalId })
      .from(t.signal)
      .where(eq(t.signal.validationId, created.validationId))
    expect(prior.length).toBeGreaterThan(0)

    await deepEnrich(
      { db: adminPool.db, t1Checkers: t1WithFakes, policy, clock: systemClock },
      { tenantId: tenant, validationId: created.validationId },
    )

    const recreated = await adminPool.db
      .select({ claimId: t.claim.claimId })
      .from(t.claim)
      .where(eq(t.claim.validationId, created.validationId))
    expect(recreated.length).toBe(1)
    const newClaimId = recreated[0]?.claimId
    if (newClaimId === undefined) throw new Error('claim nao recriado')

    const allSignals = await adminPool.db
      .select({ signalId: t.signal.signalId })
      .from(t.signal)
      .where(eq(t.signal.validationId, created.validationId))
    const evidences = await adminPool.db
      .select({ signalId: t.claimEvidence.signalId })
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimId, newClaimId))
    const covered = new Set(evidences.map((row) => row.signalId))
    for (const s of allSignals) expect(covered.has(s.signalId)).toBe(true)

    // Replay não duplica observações.
    await deepEnrich(
      { db: adminPool.db, t1Checkers: t1WithFakes, policy, clock: systemClock },
      { tenantId: tenant, validationId: created.validationId },
    )
    const after = await adminPool.db
      .select({ claimEvidenceId: t.claimEvidence.claimEvidenceId })
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimId, newClaimId))
    expect(after.length).toBe(evidences.length)
  })

  // FASE 19 — claim_evidence pode referenciar um artefato material (`evidence`)
  // de forma OPCIONAL, mas nunca um id inexistente (integridade referencial).
  it('Fase 19 — claim_evidence vincula artefato material opcional (evidence)', async () => {
    const created = await runFastPath(
      fastPathDeps,
      { tenantId: tenant, apiKeyId: 'test' },
      {
        documentType: 'CNPJ',
        documentValue: '12345678000195',
        addressInput: null,
        legalBasis: 'FRAUD_PREVENTION',
        mode: 'fast',
        idempotencyKey: 'fase19-material',
      },
    )
    const claimRows = await adminPool.db
      .select({ claimId: t.claim.claimId })
      .from(t.claim)
      .where(eq(t.claim.validationId, created.validationId))
    const claimId = claimRows[0]?.claimId
    if (claimId === undefined) throw new Error('claim row missing')

    // Fast path (T0) não produz artefato material → evidence_id nulo.
    const fastEvidence = await adminPool.db
      .select({ evidenceId: t.claimEvidence.evidenceId })
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimId, claimId))
    expect(fastEvidence.length).toBeGreaterThan(0)
    expect(fastEvidence.every((e) => e.evidenceId === null)).toBe(true)

    const materialId = randomUUID()
    await adminPool.db.insert(t.evidence).values({
      evidenceId: materialId,
      kind: 'image',
      provider: 'street_view',
      s3Uri: 's3://comprova-evidence/probe.jpg',
      sha256: Buffer.alloc(32),
      capturedAt: new Date(),
      retentionUntil: new Date(Date.now() + 86_400_000),
    })
    const linkedId = randomUUID()
    await adminPool.db.insert(t.claimEvidence).values({
      claimEvidenceId: linkedId,
      tenantId: tenant,
      claimId,
      signalId: null,
      evidenceId: materialId,
      checker: 'street_view_vlm',
      checkerVersion: '1.0.0',
      stance: 'supports',
      strength: 0.8,
      confidence: 0.9,
      source: 'street_view',
      observedAt: new Date(),
      ttlSeconds: 3600,
      expiresAt: new Date(Date.now() + 3_600_000),
      detail: {},
    })
    const readBack = await adminPool.db
      .select({ evidenceId: t.claimEvidence.evidenceId })
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimEvidenceId, linkedId))
    expect(readBack[0]?.evidenceId).toBe(materialId)

    // FK garante que não há referência órfã a artefato inexistente.
    await expect(
      adminPool.db.insert(t.claimEvidence).values({
        claimEvidenceId: randomUUID(),
        tenantId: tenant,
        claimId,
        evidenceId: randomUUID(),
        checker: 'probe',
        checkerVersion: '1.0.0',
        stance: 'unknown',
        strength: 0,
        confidence: 1,
        source: 'test',
        observedAt: new Date(),
        ttlSeconds: 60,
        expiresAt: new Date(Date.now() + 60_000),
        detail: {},
      }),
    ).rejects.toThrow()
  })
})
