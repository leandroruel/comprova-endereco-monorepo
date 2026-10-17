import {
  createTenant,
  GOLDEN_CASES,
  seedGoldenDataset,
  startTestDb,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import {
  createDbPool,
  eq,
  lte,
  makeCepReader,
  makeCnaeCategoriaReader,
  makeCnefeReader,
  makeKnownSharedReader,
  makeProfileReader,
  makeRegistryReader,
  runMigrations,
} from '@comprova/db'
import * as t from '@comprova/db'
import { addressKeys, canonicalizeAddress, loadPolicy, policyHashOf, systemClock } from '@comprova/core'
import { makeT0Checkers, makeT1Checkers, makeStreetViewVlm } from '@comprova/checkers'
import {
  makeFakeGeocoder,
  makeFakeObjectStore,
  makeFakeStreetView,
  makeFakeVisionModel,
} from '@comprova/providers'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { deepEnrich } from './deep-enrich.js'
import { makeEvidenceWriter, retentionTick } from './evidence.js'
import { runFastPath } from '../../api/src/services/fastpath.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
await seedGoldenDataset(adminPool.db)
const tenant = await createTenant(adminPool.db, { name: 'f3-tenant' })

const policyYaml = readFileSync(path.join(repoRoot, 'policies', '2026.12.1.yaml'), 'utf8')
const policy = loadPolicy(policyYaml)

const registry = makeRegistryReader(adminPool.db)
const t1Checkers = makeT1Checkers({
  geocoder: makeFakeGeocoder(() => ({
    point: { lat: -23.56, lon: -46.65 },
    precision: 'ROOFTOP' as const,
    label: null,
  })),
  cnefeCoords: {
    coordFor: async () => ({ lat: -23.56, lon: -46.65 }),
  },
  places: { id: 'fake_places', findNearbyPois: async () => [] },
})

const fakeStore = makeFakeObjectStore()
const evidenceWriter = makeEvidenceWriter(adminPool.db, fakeStore)
const t2Checkers = [
  makeStreetViewVlm({
    streetView: makeFakeStreetView(() => ({
      status: 'IMAGE_AVAILABLE' as const,
      image: new Uint8Array([9, 8, 7]),
      capturedAt: new Date('2025-06-01'),
    })),
    vision: makeFakeVisionModel(() => ({
      klass: 'RESIDENTIAL' as const,
      other_business_name: null,
      confidence: 0.8,
      notes: null,
    })),
    evidenceWriter,
  }),
]

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
  policyHash: policyHashOf(policyYaml),
  clock: systemClock,
  docHmacKey: 'test-doc-hmac-key',
}

const mkValidation = async (cnpj: string, idem: string) =>
  runFastPath(
    fastPathDeps,
    { tenantId: tenant, apiKeyId: null },
    {
      documentType: 'CNPJ',
      documentValue: cnpj,
      addressInput: null,
      legalBasis: 'FRAUD_PREVENTION',
      mode: 'auto',
      idempotencyKey: idem,
    },
  )

afterAll(async () => {
  await adminPool.end()
  await db.stop()
})

describe('deep T2: gating por ambiguidade e max_tier', () => {
  it('caso resolvido no T1 nao roda T2 (gate < 25% do dataset dourado)', async () => {
    const created = await mkValidation('12345678000195', 'f3-gate-1')
    const result = await deepEnrich(
      { db: adminPool.db, t1Checkers, t2Checkers, policy, clock: systemClock },
      { tenantId: tenant, validationId: created.validationId, maxTier: 2 },
    )
    expect(result.status).toBe('completed')
    expect(result.t2Signals).toBe(0)
  })

  it('reusa o claim do fast path e liga as evidencias T1 ao claim', async () => {
    const created = await mkValidation('12345678000195', 'deep-claim-reuse')
    const claims = await adminPool.db
      .select()
      .from(t.claim)
      .where(eq(t.claim.validationId, created.validationId))
    expect(claims.length).toBe(1)
    const claimRow = claims[0]
    if (claimRow === undefined) throw new Error('claim missing')
    const beforeRows = await adminPool.db
      .select()
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimId, claimRow.claimId))

    await deepEnrich(
      { db: adminPool.db, t1Checkers, policy, clock: systemClock },
      { tenantId: tenant, validationId: created.validationId, maxTier: 0 },
    )

    const claimsAfter = await adminPool.db
      .select()
      .from(t.claim)
      .where(eq(t.claim.validationId, created.validationId))
    expect(claimsAfter.length).toBe(1)

    const afterRows = await adminPool.db
      .select()
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimId, claimRow.claimId))
    expect(afterRows.length).toBeGreaterThanOrEqual(beforeRows.length)
    expect(afterRows.some((e) => e.checker === 'document_integrity')).toBe(true)
    // toda evidência precisa ser rastreável até um signal
    expect(afterRows.every((e) => e.signalId !== null)).toBe(true)
    // o T1 adicionou evidências novas além das T0
    expect(afterRows.some((e) => e.checker !== 'document_integrity')).toBe(true)
  })

  it('caso ambiguo com endereco roda T2, grava sinal contraditório e evidencia', async () => {
    const subjectId = randomUUID()
    await adminPool.db.insert(t.subject).values({
      subjectId,
      tenantId: tenant,
      docType: 'CNPJ',
      docHmac: randomBytes(32),
    })
    const canonical = canonicalizeAddress({
      tipoLogradouro: 'R.',
      logradouro: 'das Flores',
      numero: '100',
      bairro: 'Centro',
      cep: '01310100',
      uf: 'SP',
      municipioIbge: 3550308,
    })
    const keys = addressKeys(canonical)
    const addressRows = await adminPool.db
      .insert(t.canonicalAddress)
      .values({
        addressId: randomUUID(),
        buildingKey: keys.buildingKey,
        countryCode: 'BR',
        uf: 'SP',
        municipioIbge: 3550308,
        cep: '01310100',
        logradouroNorm: canonical.logradouroNorm,
        numero: canonical.numeroNorm,
        bairroNorm: canonical.bairroNorm,
      })
      .onConflictDoNothing()
      .returning({ addressId: t.canonicalAddress.addressId })
    const addressId =
      addressRows[0]?.addressId ??
      (
        await adminPool.db
          .select({ addressId: t.canonicalAddress.addressId })
          .from(t.canonicalAddress)
          .where(eq(t.canonicalAddress.buildingKey, keys.buildingKey))
          .limit(1)
      )[0]?.addressId
    const validationId = randomUUID()
    await adminPool.db.insert(t.validation).values({
      validationId,
      tenantId: tenant,
      subjectId,
      addressId,
      mode: 'auto',
      status: 'partial',
      policyVersion: '2026.12.1',
      legalBasis: 'FRAUD_PREVENTION',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    })

    const result = await deepEnrich(
      { db: adminPool.db, t1Checkers, t2Checkers, policy, clock: systemClock },
      { tenantId: tenant, validationId, maxTier: 2 },
    )
    expect(result.t2Signals).toBe(1)

    const signals = await adminPool.db.select().from(t.signal).where(eq(t.signal.validationId, validationId))
    const t2 = signals.find((s) => s.checkerId === 'street_view_vlm')
    expect(t2).toBeDefined()
    expect(t2?.stance).toBe('contradicts')
    expect(t2?.detail['facade']).toBe('residential')
    expect(t2?.evidenceId).not.toBeNull()

    const evidence = await adminPool.db
      .select()
      .from(t.evidence)
      .where(eq(t.evidence.evidenceId, t2?.evidenceId as string))
    expect(evidence[0]?.kind).toBe('vlm_output')

    // deep path cria claim (ausente) e liga claim_evidence aos signals
    const claims = await adminPool.db.select().from(t.claim).where(eq(t.claim.validationId, validationId))
    expect(claims.length).toBe(1)
    const claimRow = claims[0]
    if (claimRow === undefined) throw new Error('claim missing')
    expect(claimRow.type).toBe('business_registered_address')
    expect(claimRow.subjectType).toBe('organization')

    const evidences = await adminPool.db
      .select()
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimId, claimRow.claimId))
    expect(evidences.length).toBe(signals.length)
    const t2Evidence = evidences.find((e) => e.checker === 'street_view_vlm')
    expect(t2Evidence).toBeDefined()
    expect(t2Evidence?.signalId).toBe(t2?.signalId)
    expect(t2Evidence?.stance).toBe('contradicts')

    // explicação estruturada persistida (code = veredito)
    const stored = await adminPool.db
      .select({ explanation: t.validation.explanation })
      .from(t.validation)
      .where(eq(t.validation.validationId, validationId))
      .limit(1)
    expect(stored[0]?.explanation?.code).toBe(result.verdict)
    expect(Array.isArray(stored[0]?.explanation?.supporting_evidence)).toBe(true)
    expect(Array.isArray(stored[0]?.explanation?.contradicting_evidence)).toBe(true)
  })

  it('max_tier 0 desliga T2 mesmo ambiguo', async () => {
    const created = await mkValidation('90123456000131', 'f3-gate-3')
    const result = await deepEnrich(
      { db: adminPool.db, t1Checkers, t2Checkers, policy, clock: systemClock },
      { tenantId: tenant, validationId: created.validationId, maxTier: 0 },
    )
    expect(result.t2Signals).toBe(0)
  })

  it('taxa de T2 sobre o dataset dourado e < 25%', async () => {
    const t2Runs = await GOLDEN_CASES.reduce<Promise<number>>(async (acc, testCase) => {
      const prior = await acc
      const created = await mkValidation(testCase.cnpj, `f3-rate-${testCase.cnpj}`)
      const result = await deepEnrich(
        { db: adminPool.db, t1Checkers, t2Checkers, policy, clock: systemClock },
        { tenantId: tenant, validationId: created.validationId, maxTier: 2 },
      )
      return prior + (result.t2Signals > 0 ? 1 : 0)
    }, Promise.resolve(0))
    expect(t2Runs / GOLDEN_CASES.length).toBeLessThanOrEqual(0.25)
  })

  it('retention apaga evidencia expirada', async () => {
    const evidenceId = randomUUID()
    const writer = makeEvidenceWriter(adminPool.db, fakeStore)
    const storedId = await writer({
      kind: 'vlm_output',
      provider: 'fake_vision',
      data: new Uint8Array([1]),
      contentType: 'application/json',
      capturedAt: null,
      retentionDays: -1,
      detail: {},
    })
    expect(storedId).toBeDefined()
    const expired = await adminPool.db
      .select()
      .from(t.evidence)
      .where(lte(t.evidence.retentionUntil, new Date()))
    expect(expired.length).toBeGreaterThan(0)
    const removed = await retentionTick(adminPool.db, fakeStore)
    expect(removed).toBeGreaterThan(0)
    const remaining = await adminPool.db
      .select()
      .from(t.evidence)
      .where(lte(t.evidence.retentionUntil, new Date()))
    expect(remaining.length).toBe(0)
    void evidenceId
  })
})
