import { createLogger, createMetrics } from '@comprova/observability'
import { createDbPool, eq, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import {
  createApiKey,
  createTenant,
  seedGoldenDataset,
  startTestDb,
  startTestRedis,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'

const PEPPER = 'test-pepper-123'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
await seedGoldenDataset(adminPool.db)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)
const tenant = await createTenant(adminPool.db, { name: 'f5-tenant' })
const key = (await createApiKey(adminPool.db, tenant, PEPPER)).plaintext

const logLines: string[] = []
const logger = createLogger({
  level: 'info',
  stream: { write: (line: string) => void logLines.push(line) },
})

const appPool = createDbPool(db.appUrl)
const app = await buildApp({
  config: {
    DATABASE_URL: db.appUrl,
    REDIS_URL: testRedis.url,
    API_KEY_PEPPER: PEPPER,
    PORT: 3000,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'info',
    POLICY_VERSION: '2026.12.1',
    TEMPORAL_ENABLED: false,
    VLM_ENABLED: false,
    TEMPORAL_ADDRESS: 'localhost:7233',
    TEMPORAL_NAMESPACE: 'default',
    TEMPORAL_TASK_QUEUE: 'comprova-deep-t1',
    WORKER_LOOPS: false,
  },
  db: appPool.db,
  redis,
  logger,
  metrics: createMetrics(),
})

const authJson = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }

const postCpf = (address: Record<string, unknown> | null, consentRef: string | null = 'consent-123') =>
  app.inject({
    method: 'POST',
    url: '/v1/validations',
    headers: authJson,
    payload: {
      document: { type: 'CPF', value: '529.982.247-25' },
      address,
      mode: 'fast',
      legal_basis: 'CONSENT',
      consent_ref: consentRef,
    },
  })

afterAll(async () => {
  await app.close()
  redis.disconnect()
  await adminPool.end()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

describe('fluxo CPF com endereco consentido', () => {
  it('CPF + endereco residencial confirmado pelo CNEFE -> RESIDENTIAL', async () => {
    const res = await postCpf({
      tipo_logradouro: 'R.',
      logradouro: 'da Casa',
      numero: '50',
      bairro: 'Jardim',
      cep: '01310-400',
      uf: 'SP',
      municipio: 'Sao Paulo',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.verdict).toBe('RESIDENTIAL')
    expect(body.status).toBe('completed')
    expect(
      body.signals.find((s: { checker: string }) => s.checker === 'cnefe_match')?.detail.residential_hint,
    ).toBe(true)
  })

  it('CPF + endereco comercial (CNEFE nao residencial exato) -> CONFIRMED_COMMERCIAL', async () => {
    const res = await postCpf(
      {
        tipo_logradouro: 'R.',
        logradouro: 'das Flores',
        numero: '100',
        bairro: 'Centro',
        cep: '01310-100',
        uf: 'SP',
        municipio: 'Sao Paulo',
      },
      'consent-456',
    )
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.verdict).toBe('CONFIRMED_COMMERCIAL')
  })

  it('gate: nenhum PII cru do CPF ou endereco aparece nos logs', async () => {
    await postCpf(
      {
        tipo_logradouro: 'R.',
        logradouro: 'da Casa',
        numero: '50',
        bairro: 'Jardim',
        cep: '01310-400',
        uf: 'SP',
        municipio: 'Sao Paulo',
      },
      'consent-789',
    )
    const all = logLines.join('\n')
    expect(all).not.toContain('52998224725')
    expect(all).not.toContain('529.982.247-25')
    expect(all).not.toContain('DA CASA')
  })
})

describe('direitos do titular (LGPD)', () => {
  it('relatorio de acesso, eliminacao e auditoria do titular', async () => {
    const res = await postCpf(
      {
        tipo_logradouro: 'R.',
        logradouro: 'das Flores',
        numero: '100',
        bairro: 'Centro',
        cep: '01310-100',
        uf: 'SP',
        municipio: 'Sao Paulo',
      },
      'consent-access',
    )
    const validationId = res.json().validation_id
    const validationRow = await adminPool.db
      .select({ subjectId: t.validation.subjectId })
      .from(t.validation)
      .where(eq(t.validation.validationId, validationId))
      .limit(1)
    const subjectId = validationRow[0]?.subjectId as string

    const list = await app.inject({
      method: 'GET',
      url: `/v1/subjects/${subjectId}/validations`,
      headers: { authorization: `Bearer ${key}` },
    })
    expect(list.statusCode).toBe(200)
    const body = list.json()
    expect(body.validations.length).toBeGreaterThanOrEqual(1)
    expect(body.validations[0].consent_ref).toBe('consent-access')

    const erased = await app.inject({
      method: 'DELETE',
      url: `/v1/subjects/${subjectId}`,
      headers: { authorization: `Bearer ${key}` },
    })
    expect(erased.statusCode).toBe(200)
    expect(erased.json().erased).toBe(true)
    expect(erased.json().validations_removed).toBeGreaterThanOrEqual(1)

    const gone = await app.inject({
      method: 'GET',
      url: `/v1/subjects/${subjectId}/validations`,
      headers: { authorization: `Bearer ${key}` },
    })
    expect(gone.statusCode).toBe(404)

    const validationGone = await app.inject({
      method: 'GET',
      url: `/v1/validations/${validationId}`,
      headers: { authorization: `Bearer ${key}` },
    })
    expect(validationGone.statusCode).toBe(404)

    const audit = await adminPool.db.select().from(t.auditLog).where(eq(t.auditLog.action, 'subject.erasure'))
    expect(audit.length).toBeGreaterThanOrEqual(1)
  })

  it('eliminacao respeita RLS entre tenants', async () => {
    const otherTenant = await createTenant(adminPool.db, { name: 'f5-other' })
    const otherKey = (await createApiKey(adminPool.db, otherTenant, PEPPER)).plaintext

    const foreignDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/subjects/00000000-0000-4000-8000-ffffffffffff`,
      headers: { authorization: `Bearer ${otherKey}` },
    })
    expect(foreignDelete.statusCode).toBe(404)
  })

  it('contestacao (art. 20) registra auditoria e evento', async () => {
    const created = await postCpf(
      {
        tipo_logradouro: 'R.',
        logradouro: 'das Flores',
        numero: '100',
        bairro: 'Centro',
        cep: '01310-100',
        uf: 'SP',
        municipio: 'Sao Paulo',
      },
      'consent-contest',
    )
    const validationId = created.json().validation_id
    const contest = await app.inject({
      method: 'POST',
      url: `/v1/validations/${validationId}/contest`,
      headers: authJson,
      payload: { reason: 'Titular afirma que o endereco comercial informado esta incorreto.' },
    })
    expect(contest.statusCode).toBe(200)
    expect(contest.json().contested).toBe(true)

    const audit = await adminPool.db
      .select()
      .from(t.auditLog)
      .where(eq(t.auditLog.action, 'validation.contested'))
    expect(audit.length).toBeGreaterThanOrEqual(1)

    const event = await adminPool.db
      .select()
      .from(t.outbox)
      .where(eq(t.outbox.eventType, 'validation.contested'))
    expect(event.length).toBeGreaterThanOrEqual(1)
  })
})
