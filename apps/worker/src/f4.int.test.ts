import { createTenant, seedGoldenDataset, startTestDb, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import {
  createDbPool,
  eq,
  makeCepReader,
  makeCnaeCategoriaReader,
  makeCnefeReader,
  makeKnownSharedReader,
  makePartnerGraphReader,
  makeProfileReader,
  makeRegistryReader,
  runMigrations,
} from '@comprova/db'
import * as t from '@comprova/db'
import { addressKeys, canonicalizeAddress, loadPolicy, systemClock } from '@comprova/core'
import { makeT0Checkers, makeT1Checkers } from '@comprova/checkers'
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
const tenant = await createTenant(adminPool.db, { name: 'f4-tenant' })

const policy = loadPolicy(readFileSync(path.join(repoRoot, 'policies', '2026.12.1.yaml'), 'utf8'))

const contabilidadeKey = addressKeys(
  canonicalizeAddress({
    tipoLogradouro: 'AV.',
    logradouro: 'Central',
    numero: 'S/N',
    complemento: 'Sala 10',
    bairro: 'Centro',
    cep: '01310200',
    uf: 'SP',
    municipioIbge: 3550308,
  }),
).buildingKey

const partnerGraph = makePartnerGraphReader(adminPool.db)

afterAll(async () => {
  await adminPool.end()
  await db.stop()
})

describe('partner_graph (F4)', () => {
  it('consulta de grafo responde rapido e detecta padrao de fachada', async () => {
    const started = Date.now()
    const stats = await partnerGraph.statsFor({
      buildingKey: contabilidadeKey,
      cnpjBasico: '23456789',
    })
    const elapsed = Date.now() - started
    expect(stats.hasData).toBe(true)
    expect(stats.coLocatedCnpjs).toBe(3)
    expect(stats.cnpjsSharingPartner).toBe(3)
    expect(stats.recentOpeningsAtAddress).toBe(3)
    expect(elapsed).toBeLessThan(500)
  })

  it('deep path emite sinal partner_graph contraditorio e mantem veredito por hint', async () => {
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
    const created = await runFastPath(
      fastPathDeps,
      { tenantId: tenant, apiKeyId: 'test' },
      {
        documentType: 'CNPJ',
        documentValue: '23456789000195',
        addressInput: null,
        legalBasis: 'FRAUD_PREVENTION',
        mode: 'auto',
        idempotencyKey: 'f4-partner-1',
      },
    )
    expect(created.verdict).toBe('SHARED_VIRTUAL')

    const t1 = makeT1Checkers({
      geocoder: { id: 'fake', geocode: async () => null },
      cnefeCoords: { coordFor: async () => null },
      places: { id: 'fake', findNearbyPois: async () => [] },
      partnerGraph,
    })

    const deep = await deepEnrich(
      { db: adminPool.db, t1Checkers: t1, policy, clock: systemClock },
      { tenantId: tenant, validationId: created.validationId, maxTier: 0 },
    )

    const signals = await adminPool.db
      .select()
      .from(t.signal)
      .where(eq(t.signal.validationId, created.validationId))
    const partner = signals.find((s) => s.checkerId === 'partner_graph')
    expect(partner).toBeDefined()
    expect(partner?.stance).toBe('contradicts')
    expect(partner?.detail['pattern']).toBe('partner_facade')
    expect(deep.verdict).toBe('SHARED_VIRTUAL')
  })
})
