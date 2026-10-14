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
})
