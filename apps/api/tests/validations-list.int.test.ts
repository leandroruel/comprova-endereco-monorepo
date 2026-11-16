import { CUSTOMER_DOCUMENT_INTAKE_SOURCE } from '@comprova/core'
import {
  createApiKey,
  createSubject,
  createTenant,
  createValidation,
  startTestDb,
  startTestRedis,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import { createLogger, createMetrics } from '@comprova/observability'
import { createDbPool, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import Redis from 'ioredis'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

/**
 * PR #74 — listagem de validações para o Verifier (`GET /v1/validations`).
 *
 * Cobre: listagem restrita ao tenant autenticado (sessão e M2M), paginação
 * limit/offset/total, estado da submissão documental, IDOR no detalhe e na
 * listagem e ausência de PII/dados internos no DTO público de lista.
 */

const PEPPER = 'test-pepper-123'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

const tenantMain = await createTenant(adminPool.db, { name: 'vl-main' })
const tenantOther = await createTenant(adminPool.db, { name: 'vl-other' })
const keyMain = (await createApiKey(adminPool.db, tenantMain, PEPPER)).plaintext
const keyOther = (await createApiKey(adminPool.db, tenantOther, PEPPER)).plaintext

const appPool = createDbPool(db.appUrl)
const app = await buildApp({
  config: {
    DATABASE_URL: db.appUrl,
    REDIS_URL: testRedis.url,
    API_KEY_PEPPER: PEPPER,
    CREDENTIAL_ISSUER_ORIGIN: 'https://issuer.test',
    CREDENTIAL_SIGNING_KEYS: '[]',
    SIGNING_KEY_PROVIDER: 'local',
    PORT: 3000,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    POLICY_VERSION: '2026.11.1',
    TERMS_VERSION: '1.0.0',
    TERMS_APPROVED: 'true',
    TERMS_DOCUMENT_HASH: 'sha256:abc123def456',
    WORKER_LOOPS: false,
  },
  db: appPool.db,
  redis,
  logger: createLogger({ level: 'silent' }),
  metrics: createMetrics(),
})

const subjectMain = await createSubject(adminPool.db, tenantMain)
const subjectOther = await createSubject(adminPool.db, tenantOther)

// Cinco validações no tenant principal: vereditos conclusivo, inconclusivo e
// em processamento (sem veredito).
const completedValidation = await createValidation(adminPool.db, tenantMain, subjectMain, {
  status: 'completed',
  verdict: 'RESIDENTIAL',
  explanationSummary: 'Endereço parece residencial.',
})
const inconclusiveValidation = await createValidation(adminPool.db, tenantMain, subjectMain, {
  status: 'completed',
  verdict: 'INSUFFICIENT_EVIDENCE',
  explanationSummary: 'Evidência insuficiente para conclusão.',
})
const runningValidation = await createValidation(adminPool.db, tenantMain, subjectMain, {
  status: 'running',
})
const queuedValidation = await createValidation(adminPool.db, tenantMain, subjectMain, {
  status: 'queued',
})
const failedValidation = await createValidation(adminPool.db, tenantMain, subjectMain, {
  status: 'failed',
})
const mainValidationIds = [
  completedValidation,
  inconclusiveValidation,
  runningValidation,
  queuedValidation,
  failedValidation,
]

// Uma validação com documento do cliente já submetido (recibo + artefato +
// análise pendente → document_processing = true).
const documentedValidation = await createValidation(adminPool.db, tenantMain, subjectMain, {
  status: 'running',
})
{
  const claimId = randomUUID()
  await adminPool.db.insert(t.claim).values({
    claimId,
    tenantId: tenantMain,
    validationId: documentedValidation,
    subjectId: subjectMain,
    type: 'address_exists',
    subjectType: 'person',
    targetType: 'address',
  })
  const receiptId = randomUUID()
  await adminPool.db.insert(t.claimEvidence).values({
    claimEvidenceId: receiptId,
    tenantId: tenantMain,
    claimId,
    checker: 'customer_document_intake',
    checkerVersion: '1.0.0',
    stance: 'unknown',
    strength: 0,
    confidence: 0,
    source: CUSTOMER_DOCUMENT_INTAKE_SOURCE,
    observedAt: new Date(),
    ttlSeconds: 3600,
    expiresAt: new Date(Date.now() + 3_600_000),
    detail: {},
  })
  const artifactId = randomUUID()
  await adminPool.db.insert(t.evidenceArtifact).values({
    artifactId,
    tenantId: tenantMain,
    claimEvidenceId: receiptId,
    storageKey: `tenants/${tenantMain}/evidence/${artifactId}`,
    contentType: 'application/pdf',
    sizeBytes: 3,
    sha256: randomBytes(32),
    retentionUntil: new Date(Date.now() + 86_400_000),
  })
  await adminPool.db.insert(t.evidenceAnalysis).values({
    analysisId: randomUUID(),
    tenantId: tenantMain,
    artifactId,
    analyzer: 'document_intelligence',
    analyzerVersion: '1.0.0',
    contractVersion: '1.0.0',
    status: 'pending',
  })
}

const otherValidation = await createValidation(adminPool.db, tenantOther, subjectOther, {
  status: 'completed',
  verdict: 'RESIDENTIAL',
})

afterAll(async () => {
  await app.close()
  redis.disconnect()
  await adminPool.end()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

const LIST_ITEM_KEYS = [
  'validation_id',
  'status',
  'verdict',
  'score',
  'confidence',
  'has_customer_document',
  'document_processing',
  'created_at',
  'expires_at',
].sort()

describe('GET /v1/validations (PR #74)', () => {
  it('lista as validações da organização autenticada via M2M', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/validations',
      headers: { Authorization: `Bearer ${keyMain}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      validations: Record<string, unknown>[]
      total: number
      limit: number
      offset: number
    }
    expect(body.total).toBe(mainValidationIds.length + 1)
    expect(body.validations).toHaveLength(body.total)
    expect(body.limit).toBe(50)
    expect(body.offset).toBe(0)
    const listed = body.validations.map((v) => v.validation_id as string)
    for (const id of mainValidationIds) expect(listed).toContain(id)
    expect(listed).not.toContain(otherValidation)

    // DTO de lista enxuto: exatamente as chaves do contrato, sem PII nem
    // dados internos (endereço, signals, detail, hashes).
    for (const item of body.validations) {
      expect(Object.keys(item).sort()).toEqual(LIST_ITEM_KEYS)
    }
    expect(JSON.stringify(body)).not.toMatch(/storage_key|storageKey|sha256|doc_hmac|document_hash/)

    // Estado da submissão documental: só a validação com recibo marca true;
    // com análise de intake pendente, o processamento do documento está em curso.
    const byId = new Map(body.validations.map((v) => [v.validation_id as string, v]))
    expect(byId.get(documentedValidation)?.has_customer_document).toBe(true)
    expect(byId.get(documentedValidation)?.document_processing).toBe(true)
    expect(byId.get(completedValidation)?.has_customer_document).toBe(false)
    expect(byId.get(completedValidation)?.document_processing).toBe(false)

    // Estados e taxonomia preservados.
    expect(byId.get(completedValidation)?.verdict).toBe('RESIDENTIAL')
    expect(byId.get(inconclusiveValidation)?.verdict).toBe('INSUFFICIENT_EVIDENCE')
    expect(byId.get(runningValidation)?.verdict).toBeNull()
    expect(byId.get(failedValidation)?.status).toBe('failed')
  })

  it('pagina com limit/offset e ordenação estável por criação desc', async () => {
    const page1 = await app.inject({
      method: 'GET',
      url: '/v1/validations?limit=2&offset=0',
      headers: { Authorization: `Bearer ${keyMain}` },
    })
    expect(page1.statusCode).toBe(200)
    const body1 = page1.json() as {
      validations: { validation_id: string; created_at: string }[]
      total: number
      limit: number
      offset: number
    }
    expect(body1.total).toBe(mainValidationIds.length + 1)
    expect(body1.validations).toHaveLength(2)
    expect(body1.limit).toBe(2)
    expect(body1.offset).toBe(0)

    const page2 = await app.inject({
      method: 'GET',
      url: '/v1/validations?limit=2&offset=2',
      headers: { Authorization: `Bearer ${keyMain}` },
    })
    const body2 = page2.json() as {
      validations: { validation_id: string; created_at: string }[]
      total: number
    }
    expect(body2.validations).toHaveLength(2)
    expect(body2.total).toBe(body1.total)
    const page1Ids = body1.validations.map((v) => v.validation_id)
    const page2Ids = body2.validations.map((v) => v.validation_id)
    for (const id of page2Ids) expect(page1Ids).not.toContain(id)

    // Ordenação desc: created_at não-crescente dentro da página e entre páginas.
    const all = [...body1.validations, ...body2.validations]
    for (let i = 1; i < all.length; i += 1) {
      expect(new Date(all[i - 1]!.created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(all[i]!.created_at).getTime(),
      )
    }

    // Offset além do total: página vazia, sem erro.
    const pageEnd = await app.inject({
      method: 'GET',
      url: `/v1/validations?limit=2&offset=${body1.total + 10}`,
      headers: { Authorization: `Bearer ${keyMain}` },
    })
    expect(pageEnd.statusCode).toBe(200)
    expect((pageEnd.json() as { validations: unknown[] }).validations).toHaveLength(0)
  })

  it('M2M com tenantId divergente no query é rejeitado (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/validations?tenantId=${tenantOther}`,
      headers: { Authorization: `Bearer ${keyMain}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('limit inválido é rejeitado (400)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/validations?limit=0',
      headers: { Authorization: `Bearer ${keyMain}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('IDOR: detalhe e listagem de outro tenant não vazam dados (M2M)', async () => {
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/validations/${otherValidation}`,
      headers: { Authorization: `Bearer ${keyMain}` },
    })
    expect(detail.statusCode).toBe(404)

    const list = await app.inject({
      method: 'GET',
      url: `/v1/validations?tenantId=${tenantOther}`,
      headers: { Authorization: `Bearer ${keyOther}` },
    })
    expect(list.statusCode).toBe(200)
    const ids = (list.json() as { validations: { validation_id: string }[] }).validations.map(
      (v) => v.validation_id,
    )
    expect(ids).toEqual([otherValidation])
    expect(ids).not.toContain(completedValidation)
  })

  describe('sessão de usuário (dashboard do Verifier)', () => {
    let sessionCookie: string
    let memberId = ''

    beforeAll(async () => {
      const signUp = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'verifier@exemplo.com', password: 'SenhaForte123!', name: 'Verifier' }),
      })
      expect(signUp.statusCode).toBe(200)
      memberId = (signUp.json() as { user: { id: string } }).user.id

      const signIn = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'verifier@exemplo.com', password: 'SenhaForte123!' }),
      })
      const setCookie = signIn.headers['set-cookie']
      const header = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie
      const token = header?.match(/legacy-auth\.session_token=([^;]+)/)?.[1]
      if (!token) throw new Error('session token missing')
      sessionCookie = token

      // Membership direto da organização principal (o middleware valida
      // membership em organization_member com RLS por app.user_id).
      await adminPool.db.insert(t.organizationMember).values({
        organizationMemberId: randomUUID(),
        tenantId: tenantMain,
        userId: memberId,
        role: 'owner',
        invitedBy: null,
      })
    })

    const injectWithSession = (url: string) =>
      app.inject({
        method: 'GET',
        url,
        headers: { Cookie: `legacy-auth.session_token=${sessionCookie}` },
      })

    it('lista as validações da própria organização (tenant validado por membership)', async () => {
      const res = await injectWithSession(`/v1/validations?tenantId=${tenantMain}`)
      expect(res.statusCode).toBe(200)
      const body = res.json() as { validations: { validation_id: string }[]; total: number }
      const ids = body.validations.map((v) => v.validation_id)
      expect(ids).toContain(completedValidation)
      expect(ids).not.toContain(otherValidation)
    })

    it('membership de outra organização não lista validações alheias e detalhe responde 404', async () => {
      // Usuário membro apenas do tenantOther.
      const signUp = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'other@exemplo.com',
          password: 'SenhaForte123!',
          name: 'Outro Verifier',
        }),
      })
      const otherUserId = (signUp.json() as { user: { id: string } }).user.id
      await adminPool.db.insert(t.organizationMember).values({
        organizationMemberId: randomUUID(),
        tenantId: tenantOther,
        userId: otherUserId,
        role: 'owner',
        invitedBy: null,
      })
      const signIn = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'other@exemplo.com', password: 'SenhaForte123!' }),
      })
      const setCookie = signIn.headers['set-cookie']
      const header = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie
      const otherToken = header?.match(/legacy-auth\.session_token=([^;]+)/)?.[1]
      if (!otherToken) throw new Error('session token missing')

      const list = await app.inject({
        method: 'GET',
        url: `/v1/validations?tenantId=${tenantOther}`,
        headers: { Cookie: `legacy-auth.session_token=${otherToken}` },
      })
      expect(list.statusCode).toBe(200)
      const ids = (list.json() as { validations: { validation_id: string }[] }).validations.map(
        (v) => v.validation_id,
      )
      expect(ids).toEqual([otherValidation])
      expect(ids).not.toContain(completedValidation)

      // IDOR no detalhe: validação de outro tenant → 404 (mesmo com id
      // conhecido). Sessão exige tenantId no query; o membership resolve o
      // tenantOther e a validação do tenantMain não é visível.
      const detail = await app.inject({
        method: 'GET',
        url: `/v1/validations/${completedValidation}?tenantId=${tenantOther}`,
        headers: { Cookie: `legacy-auth.session_token=${otherToken}` },
      })
      expect(detail.statusCode).toBe(404)
    })

    it('sessão sem tenantId no query é rejeitada (400)', async () => {
      const res = await injectWithSession('/v1/validations')
      expect(res.statusCode).toBe(400)
    })
  })

  it('regressão: detalhe por M2M continua intacto e expõe has_customer_document', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/validations/${completedValidation}`,
      headers: { Authorization: `Bearer ${keyMain}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      validation_id: string
      verdict: string
      status: string
      has_customer_document?: boolean
    }
    expect(body.validation_id).toBe(completedValidation)
    expect(body.verdict).toBe('RESIDENTIAL')
    expect(body.status).toBe('completed')
    expect(body.has_customer_document).toBe(false)

    // A validação com recibo materializado expõe a presença do documento.
    const documented = await app.inject({
      method: 'GET',
      url: `/v1/validations/${documentedValidation}`,
      headers: { Authorization: `Bearer ${keyMain}` },
    })
    expect(documented.statusCode).toBe(200)
    expect((documented.json() as { has_customer_document?: boolean }).has_customer_document).toBe(true)
  })
})
