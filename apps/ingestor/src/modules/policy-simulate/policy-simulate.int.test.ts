import {
  createSubject,
  createTenant,
  createValidation,
  startTestDb,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import { createDbPool, runMigrations, type Db } from '@comprova/db'
import * as t from '@comprova/db'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { simulatePolicy } from './policy-simulate.service.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const tenant = await createTenant(adminPool.db, { name: 'sim-tenant' })

afterAll(async () => {
  await adminPool.end()
  await db.stop()
})

const insertSignals = async (
  db: Db,
  validationId: string,
  signals: ReadonlyArray<{
    checkerId: string
    stance: 'supports' | 'contradicts' | 'neutral' | 'unknown'
    strength: number
    confidence: number
    detail: Record<string, unknown>
  }>,
): Promise<void> => {
  await db.insert(t.signal).values(
    signals.map((s) => ({
      signalId: randomUUID(),
      validationId,
      checkerId: s.checkerId,
      checkerVersion: '1.0.0',
      stance: s.stance,
      strength: s.strength,
      confidence: s.confidence,
      source: 'sim',
      observedAt: new Date(),
      ttlSeconds: 3600,
      detail: s.detail,
    })),
  )
}

describe('simulador de politicas (shadow mode)', () => {
  it('replay de validacoes historicas com politica-alvo relata divergencias', async () => {
    const subject = await createSubject(adminPool.db, tenant)

    const confirmed = await createValidation(adminPool.db, tenant, subject, {
      verdict: 'CONFIRMED_COMMERCIAL',
    })
    await insertSignals(adminPool.db, confirmed, [
      { checkerId: 'document_integrity', stance: 'supports', strength: 0.5, confidence: 1, detail: {} },
      {
        checkerId: 'registry_status',
        stance: 'supports',
        strength: 0.5,
        confidence: 0.95,
        detail: { situacao: 'ativa' },
      },
      {
        checkerId: 'country_check',
        stance: 'supports',
        strength: 0.2,
        confidence: 0.9,
        detail: { country: 'BR' },
      },
      {
        checkerId: 'cep_consistency',
        stance: 'supports',
        strength: 0.6,
        confidence: 0.9,
        detail: { cep: '01310100' },
      },
      {
        checkerId: 'cnefe_match',
        stance: 'supports',
        strength: 0.6,
        confidence: 0.9,
        detail: { match: 'exact_number' },
      },
      {
        checkerId: 'cotenancy',
        stance: 'supports',
        strength: 0.4,
        confidence: 0.8,
        detail: { other_active_cnpjs: 0 },
      },
    ])

    const flimsy = await createValidation(adminPool.db, tenant, subject, {
      verdict: 'CONFIRMED_COMMERCIAL',
    })
    await insertSignals(adminPool.db, flimsy, [
      { checkerId: 'document_integrity', stance: 'supports', strength: 0.5, confidence: 1, detail: {} },
      { checkerId: 'registry_status', stance: 'unknown', strength: 0, confidence: 0.5, detail: {} },
      { checkerId: 'cnefe_match', stance: 'unknown', strength: 0, confidence: 0.4, detail: {} },
      { checkerId: 'cotenancy', stance: 'unknown', strength: 0, confidence: 0.3, detail: {} },
    ])

    const report = await simulatePolicy(adminPool.db, '2026.12.1', repoRoot)
    expect(report.total).toBeGreaterThanOrEqual(2)
    expect(report.samples.length).toBeGreaterThanOrEqual(1)
    const divergentIds = report.samples.map((s) => s.validationId)
    expect(divergentIds).toContain(flimsy)
    expect(divergentIds).not.toContain(confirmed)
    const transition = report.transitions.find(
      (tr) => tr.from === 'CONFIRMED_COMMERCIAL' && tr.to === 'INSUFFICIENT_EVIDENCE',
    )
    expect(transition?.count).toBeGreaterThanOrEqual(1)
  })
})
