import {
  createTenant,
  GOLDEN_CASES,
  seedGoldenDataset,
  startTestDb,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import { createDbPool, eq, lte, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import { loadPolicy, systemClock } from '@comprova/core'
import { makeT0Checkers, makeT1Checkers, makeStreetViewVlm } from '@comprova/checkers'
import {
  makeFakeGeocoder,
  makeFakeObjectStore,
  makeFakeStreetView,
  makeFakeVisionModel,
} from '@comprova/providers'
import { randomUUID } from 'node:crypto'
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

const policy = loadPolicy(readFileSync(path.join(repoRoot, 'policies', '2026.12.1.yaml'), 'utf8'))

const registry = { getEstabelecimento: async () => null }
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
  registry: {
    getEstabelecimento: async () => null,
  },
  checkers: makeT0Checkers({
    registry,
    cnefe: { findAddress: async () => null },
    cep: { get: async () => null },
    profile: { getProfile: async () => null, getOtherActiveCnpjs: async () => [] },
    knownShared: { get: async () => null },
    cnaeCategoria: { categoriaForDivisao: async () => 'MIXED' as const },
  }),
  policy,
  clock: systemClock,
  docHmacKey: 'test-doc-hmac-key',
}

const mkValidation = async (cnpj: string, idem: string) =>
  runFastPath(
    fastPathDeps,
    { tenantId: tenant, apiKeyId: 'test' },
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

  it('caso ambiguo roda T2 e grava sinal + evidencia', async () => {
    const created = await mkValidation('90123456000131', 'f3-gate-2')
    const result = await deepEnrich(
      { db: adminPool.db, t1Checkers, t2Checkers, policy, clock: systemClock },
      { tenantId: tenant, validationId: created.validationId, maxTier: 2 },
    )
    expect(result.t2Signals).toBe(1)

    const signals = await adminPool.db
      .select()
      .from(t.signal)
      .where(eq(t.signal.validationId, created.validationId))
    const t2 = signals.find((s) => s.checkerId === 'street_view_vlm')
    expect(t2).toBeDefined()
    expect(t2?.stance).toBe('unknown')
    expect(t2?.evidenceId).not.toBeNull()

    const evidence = await adminPool.db
      .select()
      .from(t.evidence)
      .where(eq(t.evidence.evidenceId, t2?.evidenceId as string))
    expect(evidence[0]?.kind).toBe('vlm_output')
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
    expect(t2Runs / GOLDEN_CASES.length).toBeLessThan(0.25)
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
