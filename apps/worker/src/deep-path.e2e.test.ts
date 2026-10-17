/**
 * End-to-end do deep path: serviço do fast path (API) -> Temporal (container
 * real) -> workflow `deepValidationWorkflow` -> worker -> activity
 * `deepEnrichActivity` -> Postgres (container real).
 *
 * Diferente dos testes de integração existentes, aqui o núcleo do worker é
 * exercitado pela fronteira real do Temporal (task queue, serialização,
 * workflow proxy) em vez de chamar `deepEnrich()` in-process. Nada de provider
 * externo: os checkers T1 rodam com geocoder/places falsos.
 */
import { makeT0Checkers, makeT1Checkers } from '@comprova/checkers'
import { loadPolicy, policyHashOf, systemClock } from '@comprova/core'
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
import { createCLILogger } from '@comprova/observability'
import { makeFakeGeocoder, makeFakePlaces } from '@comprova/providers'
import {
  createTenant,
  seedGoldenDataset,
  startTestDb,
  startTestTemporal,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import { Client } from '@temporalio/client'
// O worker exige o `NativeConnection` (core Rust). Em 1.24 o `Connection` de
// `@temporalio/client` é o cliente gRPC em JS e não serve para `Worker.create`.
import { NativeConnection, Worker } from '@temporalio/worker'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { startDeepWorkflow } from '../../api/src/services/deep-trigger.js'
import { runFastPath, type FastPathDeps } from '../../api/src/services/fastpath.js'
import { makeDeepEnrichActivity } from './modules/deep-enrich/deep-enrich.activity.js'
import type { DeepEnrichDeps } from './modules/deep-enrich/deep-enrich.service.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../../')

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
await seedGoldenDataset(adminPool.db)
const tenant = await createTenant(adminPool.db, { name: 'deep-e2e-tenant' })

const temporal = await startTestTemporal()
const taskQueue = `e2e-deep-${randomUUID()}`

const policyYaml = readFileSync(path.join(repoRoot, 'policies', '2026.11.1.yaml'), 'utf8')
const policy = loadPolicy(policyYaml)

afterAll(async () => {
  await adminPool.end()
  await temporal.stop()
  await db.stop()
})

const registry = makeRegistryReader(adminPool.db)

const fastPathDeps: FastPathDeps = {
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

const deepDeps: DeepEnrichDeps = {
  db: adminPool.db,
  t1Checkers: makeT1Checkers({
    geocoder: makeFakeGeocoder(() => ({
      point: { lat: -23.56, lon: -46.65 },
      precision: 'ROOFTOP' as const,
      label: 'Rua das Flores, 100',
    })),
    cnefeCoords: { coordFor: async () => ({ lat: -23.56, lon: -46.65 }) },
    places: makeFakePlaces([
      { name: 'Loja das Flores', lat: -23.56, lon: -46.65, categories: ['shop=florist'] },
    ]),
  }),
  t2Checkers: [],
  policy,
  clock: systemClock,
}

describe('deep path e2e (API -> Temporal -> worker -> Postgres)', () => {
  it('executa o workflow real, persiste o enriquecimento e conclui a validação', async () => {
    // 1) Fast path (camada de serviço da API) cria a validação em `queued`.
    const created = await runFastPath(
      fastPathDeps,
      { tenantId: tenant, apiKeyId: null },
      {
        documentType: 'CNPJ',
        documentValue: '12345678000195',
        addressInput: null,
        legalBasis: 'FRAUD_PREVENTION',
        mode: 'deep',
        idempotencyKey: `e2e-deep-${randomUUID()}`,
      },
    )
    expect(created.status).toBe('queued')

    // 2) O trigger da API enfileira o workflow no Temporal real.
    const workflowId = await startDeepWorkflow(
      {
        config: { enabled: true, address: temporal.address, namespace: 'default', taskQueue },
        logger: createCLILogger('e2e-deep', 'warn'),
      },
      { tenantId: tenant, validationId: created.validationId },
    )
    expect(workflowId).toBe(`deep-${created.validationId}`)
    if (workflowId === null) throw new Error('workflow do deep path não foi iniciado')

    // 3) Um worker de verdade consome a task queue e roda a activity.
    const connection = await NativeConnection.connect({ address: temporal.address })
    const client = new Client({ connection, namespace: 'default' })
    try {
      const worker = await Worker.create({
        connection,
        taskQueue,
        workflowsPath: path.join(here, 'workflows', 'deep.ts'),
        activities: { deepEnrichActivity: makeDeepEnrichActivity(deepDeps) },
      })

      const result = await worker.runUntil(client.workflow.getHandle(workflowId).result())

      // 4) O resultado vem do workflow, não de uma chamada in-process.
      expect(result.status).toBe('completed')
      expect(result.verdict).toBe('CONFIRMED_COMMERCIAL')
      expect(result.newSignals).toBe(3)
    } finally {
      await connection.close()
    }

    // 5) Efeitos colaterais que só a activity (via Temporal) produz.
    const rows = await adminPool.db
      .select({
        status: t.validation.status,
        verdict: t.validation.verdict,
        completedAt: t.validation.completedAt,
        evidenceSetHash: t.validation.evidenceSetHash,
      })
      .from(t.validation)
      .where(eq(t.validation.validationId, created.validationId))
    expect(rows[0]?.status).toBe('completed')
    expect(rows[0]?.verdict).toBe('CONFIRMED_COMMERCIAL')
    expect(rows[0]?.completedAt).not.toBeNull()
    expect(rows[0]?.evidenceSetHash).not.toBeNull()

    const signals = await adminPool.db
      .select({ checkerId: t.signal.checkerId })
      .from(t.signal)
      .where(eq(t.signal.validationId, created.validationId))
    expect(signals.map((s) => s.checkerId)).toEqual(
      expect.arrayContaining(['geocode_consensus', 'places_match', 'digital_footprint']),
    )

    const usage = await adminPool.db
      .select({ kind: t.usageEvent.kind, units: t.usageEvent.units })
      .from(t.usageEvent)
      .where(eq(t.usageEvent.validationId, created.validationId))
    expect(usage).toContainEqual({ kind: 'deep', units: 1 })

    const outbox = await adminPool.db
      .select({ eventType: t.outbox.eventType })
      .from(t.outbox)
      .where(eq(t.outbox.aggregateId, created.validationId))
    expect(outbox.map((row) => row.eventType)).toContain('validation.completed')
  })
})
