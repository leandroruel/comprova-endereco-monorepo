import {
  createApiKey,
  createTenant,
  startTestDb,
  startTestRedis,
  TEST_APP_DB_PASSWORD,
  seedGoldenDataset,
  GOLDEN_CASES,
} from '@comprova/testing'
import { createLogger, createMetrics } from '@comprova/observability'
import { decide, weightedScore, type Signal } from '@comprova/core'
import { createDbPool, eq, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { loadPolicyFile } from './policy-loader.js'

const PEPPER = 'test-pepper-123'
const differentialPolicy = loadPolicyFile('2026.11.1')

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
await seedGoldenDataset(adminPool.db)

const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)
const tenant = await createTenant(adminPool.db, { name: 'golden-tenant' })
const key = (await createApiKey(adminPool.db, tenant, PEPPER)).plaintext

const appPool = createDbPool(db.appUrl)
const app = await buildApp({
  config: {
    DATABASE_URL: db.appUrl,
    REDIS_URL: testRedis.url,
    API_KEY_PEPPER: PEPPER,
    CREDENTIAL_ISSUER_ORIGIN: 'https://issuer.test',
    PORT: 3000,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    POLICY_VERSION: '2026.11.1',
    TEMPORAL_ENABLED: false,
    VLM_ENABLED: false,
    TEMPORAL_ADDRESS: 'localhost:7233',
    TEMPORAL_NAMESPACE: 'default',
    TEMPORAL_TASK_QUEUE: 'comprova-deep-t1',
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
  await adminPool.end()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

const postValidation = (cnpj: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/validations',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
    payload: {
      document: { type: 'CNPJ', value: cnpj },
      address: null,
      mode: 'fast',
      legal_basis: 'FRAUD_PREVENTION',
    },
  })

describe('dataset dourado T0 (gate >= 85% por classe)', () => {
  it('todas as classes T0 batem o veredito esperado', async () => {
    const results = await GOLDEN_CASES.reduce<
      Promise<readonly { label: string; expected: string; actual: string; confidence: number }[]>
    >(async (acc, testCase) => {
      const prior = await acc
      const res = await postValidation(testCase.cnpj)
      if (res.statusCode !== 200) {
        return [
          ...prior,
          {
            label: testCase.label,
            expected: testCase.expectedVerdict,
            actual: `HTTP ${res.statusCode}: ${res.body.slice(0, 120)}`,
            confidence: 0,
          },
        ]
      }
      const body = res.json()
      return [
        ...prior,
        {
          label: testCase.label,
          expected: testCase.expectedVerdict,
          actual: body.verdict,
          confidence: body.confidence,
        },
      ]
    }, Promise.resolve([]))

    const perClass = new Map<string, { correct: number; total: number }>()
    for (const r of results) {
      const entry = perClass.get(r.expected) ?? { correct: 0, total: 0 }
      perClass.set(r.expected, {
        correct: entry.correct + (r.actual === r.expected ? 1 : 0),
        total: entry.total + 1,
      })
    }
    const failures = results.filter((r) => r.actual !== r.expected)
    const accuracyByClass = [...perClass.entries()].map(([cls, v]) => `${cls}: ${v.correct}/${v.total}`)
    expect(failures, `falhas: ${JSON.stringify(failures, null, 2)} | ${accuracyByClass.join(', ')}`).toEqual(
      [],
    )
    for (const [, v] of perClass) {
      expect(v.correct / v.total).toBeGreaterThanOrEqual(0.85)
    }
  })

  it('resposta inclui sinais, politica versionada e building key', async () => {
    const res = await postValidation(GOLDEN_CASES[0]?.cnpj as string)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.policy_version).toBe('2026.11.1')
    expect(body.signals.length).toBeGreaterThan(3)
    expect(body.address).not.toBeNull()
    expect(body.address.building_key).toMatch(/^b64:/)
    expect(body.expires_at).toBeDefined()
  })

  it('Idempotency-Key devolve a mesma validacao', async () => {
    const cnpj = GOLDEN_CASES[0]?.cnpj as string
    const first = await postValidation(cnpj, { 'idempotency-key': 'golden-idem-key-1' })
    const second = await postValidation(cnpj, { 'idempotency-key': 'golden-idem-key-1' })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(second.json().validation_id).toBe(first.json().validation_id)
  })

  it('CNPJ com digitos invalidos retorna 422 INVALID_DOCUMENT', async () => {
    const res = await postValidation('11111111111111')
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('INVALID_DOCUMENT')
  })

  it('CPF sem endereco retorna 422 ADDRESS_REQUIRED_FOR_CPF', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/validations',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: {
        document: { type: 'CPF', value: '52998224725' },
        address: null,
        mode: 'fast',
        legal_basis: 'CONSENT',
      },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('ADDRESS_REQUIRED_FOR_CPF')
  })

  it('mode deep responde 422 quando VLM desabilitado', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/validations',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: {
        document: { type: 'CNPJ', value: GOLDEN_CASES[0]?.cnpj },
        address: null,
        mode: 'deep',
        legal_basis: 'FRAUD_PREVENTION',
      },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('DEEP_PATH_DISABLED')
  })
})

// Fase 10 introduziu `evaluateClaim({ claim, evidence, policy })` como fronteira única
// de scoring. Este teste diferencial prova, ponta-a-ponta, que a saída persistida pelo
// caminho novo é idêntica ao caminho antigo (`weightedScore` + `decide` sobre os
// signals brutos), classe a classe do dataset dourado.
describe('Fase 11 — diferencial OLD (signals) vs NEW (evaluateClaim)', () => {
  it('NEW persistido == OLD recomputado dos signals brutos em todas as classes', async () => {
    const mismatches: Array<Record<string, unknown>> = []

    for (const testCase of GOLDEN_CASES) {
      const res = await postValidation(testCase.cnpj)
      if (res.statusCode !== 200) {
        mismatches.push({ case: testCase.label, field: 'http', old: 200, novo: res.statusCode })
        continue
      }
      const validationId = res.json().validation_id as string

      const rows = await adminPool.db
        .select({
          verdict: t.validation.verdict,
          score: t.validation.score,
          confidence: t.validation.confidence,
          explanation: t.validation.explanation,
          createdAt: t.validation.createdAt,
        })
        .from(t.validation)
        .where(eq(t.validation.validationId, validationId))
      const row = rows[0]
      if (row === undefined) {
        mismatches.push({ case: testCase.label, field: 'row', old: 'present', novo: 'missing' })
        continue
      }

      // Reconstrói os signals brutos exatamente como o checker os produziu
      // (o `signal` preserva o stance de 4 valores, incl. `neutral`).
      const signalRows = await adminPool.db
        .select({
          checkerId: t.signal.checkerId,
          checkerVersion: t.signal.checkerVersion,
          stance: t.signal.stance,
          strength: t.signal.strength,
          confidence: t.signal.confidence,
          source: t.signal.source,
          observedAt: t.signal.observedAt,
          ttlSeconds: t.signal.ttlSeconds,
          detail: t.signal.detail,
        })
        .from(t.signal)
        .where(eq(t.signal.validationId, validationId))
      const signals: Signal[] = signalRows.map((s) => ({
        checkerId: s.checkerId,
        checkerVersion: s.checkerVersion,
        stance: s.stance,
        strength: s.strength,
        confidence: s.confidence,
        source: s.source,
        observedAt: s.observedAt.toISOString(),
        ttlSeconds: s.ttlSeconds,
        detail: s.detail,
      }))

      const now = row.createdAt
      const oldScore = weightedScore(signals, differentialPolicy, now)
      const oldDecision = decide({ signals, score: oldScore, policy: differentialPolicy, now })

      const record = (field: string, old: unknown, novo: unknown): void => {
        mismatches.push({ case: testCase.label, field, old, novo })
      }
      if (oldDecision.verdict !== row.verdict) record('verdict', oldDecision.verdict, row.verdict)
      if (Math.abs(oldDecision.confidence - (row.confidence ?? 0)) > 1e-4) {
        record('confidence', oldDecision.confidence, row.confidence)
      }
      if (Math.abs(Math.tanh(oldScore) - (row.score ?? 0)) > 1e-4) {
        record('score', Math.tanh(oldScore), row.score)
      }
      if (oldDecision.explanation !== (row.explanation?.summary ?? '')) {
        record('explanation', oldDecision.explanation, row.explanation?.summary)
      }
    }

    expect(mismatches, `divergências OLD≠NEW: ${JSON.stringify(mismatches, null, 2)}`).toEqual([])
  })
})
