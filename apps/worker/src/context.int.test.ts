import { makeFakeObjectStore } from '@comprova/providers'
import type { EvidenceWriter } from '@comprova/checkers'
import { buildT2Checkers } from './context.js'
import type { WorkerEnv } from './config.js'
import { makeEvidenceWriter } from './modules/evidence/evidence.service.js'
import { createDbPool, EVIDENCE_ARTIFACT_MAX_BYTES } from '@comprova/db'
import { createTenant, startTestDb, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import { runMigrations } from '@comprova/db'
import { afterAll, describe, expect, it } from 'vitest'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const tenant = await createTenant(adminPool.db, { name: 'vlm-flag-tenant' })

const envWith = (vlmEnabled: boolean): WorkerEnv => ({
  databaseUrl: db.appUrl,
  policyVersion: '2026.12.1',
  repoRoot: process.cwd(),
  vlmEnabled,
  evidenceAnalysisMaxBytes: EVIDENCE_ARTIFACT_MAX_BYTES,
})

afterAll(async () => {
  await adminPool.end()
  await db.stop()
})

const writer: EvidenceWriter = async () => 'ev-test'

describe('feature flag VLM_ENABLED (gate do step de IA)', () => {
  it('false (default): pipeline nao inclui o checker de IA — apenas deterministico', () => {
    const t2 = buildT2Checkers(envWith(false), writer)
    expect(t2).toEqual([])
  })

  it('true: pipeline inclui street_view_vlm no T2', () => {
    const t2 = buildT2Checkers(envWith(true), writer)
    expect(t2.length).toBe(1)
    expect(t2[0]?.id).toBe('street_view_vlm')
    expect(t2[0]?.tier).toBe(2)
  })

  it('evidence writer funcional com object store fake (usado quando habilitado)', async () => {
    const pool = createDbPool(db.adminUrl)
    try {
      const realWriter = makeEvidenceWriter(pool.db, makeFakeObjectStore())
      const id = await realWriter({
        kind: 'vlm_output',
        provider: 'fake_vision',
        data: new Uint8Array([1]),
        contentType: 'application/json',
        capturedAt: null,
        retentionDays: 365,
        detail: {},
      })
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
      void tenant
    } finally {
      await pool.end()
    }
  })
})
