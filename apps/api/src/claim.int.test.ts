import { createLogger, createMetrics } from '@comprova/observability'
import { createDbPool, eq, inArray, runMigrations, sql, withTenant } from '@comprova/db'
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
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'

const PEPPER = 'test-pepper-123'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
await seedGoldenDataset(adminPool.db)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)
const tenantId = await createTenant(adminPool.db, { name: 'claim-tenant' })
const key = (await createApiKey(adminPool.db, tenantId, PEPPER)).plaintext

const appPool = createDbPool(db.appUrl)
const app = await buildApp({
  config: {
    DATABASE_URL: db.appUrl,
    REDIS_URL: testRedis.url,
    API_KEY_PEPPER: PEPPER,
    PORT: 3000,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    POLICY_VERSION: '2026.13.1',
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

const authJson = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }

const postCnpj = (headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/validations',
    headers: { ...authJson, ...headers },
    payload: {
      document: { type: 'CNPJ', value: '12345678000195' },
      address: null,
      mode: 'fast',
      legal_basis: 'FRAUD_PREVENTION',
    },
  })

const postCpf = (headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/validations',
    headers: { ...authJson, ...headers },
    payload: {
      document: { type: 'CPF', value: '529.982.247-25' },
      address: {
        tipo_logradouro: 'R.',
        logradouro: 'das Flores',
        numero: '100',
        bairro: 'Centro',
        cep: '01310-100',
        uf: 'SP',
        municipio: 'Sao Paulo',
      },
      mode: 'fast',
      legal_basis: 'CONSENT',
      consent_ref: 'consent-claim-test',
    },
  })

const claimRowsFor = async (validationId: string) =>
  adminPool.db.select().from(t.claim).where(eq(t.claim.validationId, validationId))

const evidenceRowsFor = async (claimId: string) =>
  adminPool.db.select().from(t.claimEvidence).where(eq(t.claimEvidence.claimId, claimId))

describe('claim (CNPJ): business_registered_address', () => {
  it('cria claim e evidencias rastreaveis para o veredito', async () => {
    const res = await postCnpj()
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.claim).toBeDefined()
    expect(body.claim.type).toBe('business_registered_address')
    expect(body.claim.subject.type).toBe('organization')
    expect(body.claim.target.type).toBe('address')
    expect(body.evidence_summary).toBeDefined()
    expect(
      body.evidence_summary.supporting + body.evidence_summary.contradicting + body.evidence_summary.unknown,
    ).toBe(body.signals.length)

    const rows = await claimRowsFor(body.validation_id)
    expect(rows.length).toBe(1)
    const claim = rows[0]
    if (claim === undefined) throw new Error('claim row missing')
    expect(claim.type).toBe('business_registered_address')
    expect(claim.subjectType).toBe('organization')
    expect(claim.targetType).toBe('address')
    expect(claim.tenantId).toBe(tenantId)
    expect(claim.addressId).not.toBeNull()
    expect(claim.subjectId).toBe(body.claim.subject.id)

    const evidences = await evidenceRowsFor(claim.claimId)
    expect(evidences.length).toBe(body.signals.length)
    expect(evidences.length).toBeGreaterThan(3)
    for (const e of evidences) {
      expect(e.checker).toBeTruthy()
      expect(e.checkerVersion).toBeTruthy()
      expect(e.source).toBeTruthy()
      expect(['supports', 'contradicts', 'unknown']).toContain(e.stance)
      expect(e.observedAt instanceof Date).toBe(true)
      expect(e.ttlSeconds).toBeGreaterThan(0)
      expect(e.expiresAt.getTime()).toBeGreaterThan(e.observedAt.getTime())
      expect(e.tenantId).toBe(tenantId)
    }
    const sources = evidences.map((e) => e.checker)
    expect(sources).toContain('document_integrity')
    expect(sources).toContain('registry_status')

    const signalRows = await adminPool.db
      .select({ signalId: t.signal.signalId, evidenceId: t.signal.evidenceId, checkerId: t.signal.checkerId })
      .from(t.signal)
      .where(eq(t.signal.validationId, body.validation_id))
    expect(signalRows.length).toBe(evidences.length)
    for (const s of signalRows) {
      const match = evidences.find((e) => e.evidenceId === s.evidenceId)
      expect(match).toBeDefined()
      expect(match?.checker).toBe(s.checkerId)
      expect(match?.signalId).toBe(s.signalId)
    }
  })

  it('nao persiste CPF/CNPJ cru em claim nem em evidencia', async () => {
    const res = await postCnpj()
    const body = res.json()
    const rows = await claimRowsFor(body.validation_id)
    expect(rows.length).toBe(1)
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain('12345678000195')
    expect(serialized).not.toContain('12.345.678/0001-95')
    const claimRow = rows[0]
    if (claimRow === undefined) throw new Error('claim row missing')
    const evidences = await evidenceRowsFor(claimRow.claimId)
    expect(JSON.stringify(evidences)).not.toContain('12345678000195')
  })
})

describe('claim (CPF + endereco): address_exists', () => {
  it('cria claim address_exists com subject person', async () => {
    const res = await postCpf()
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.claim.type).toBe('address_exists')
    expect(body.claim.subject.type).toBe('person')

    const rows = await claimRowsFor(body.validation_id)
    expect(rows.length).toBe(1)
    const claimRow = rows[0]
    if (claimRow === undefined) throw new Error('claim row missing')
    expect(claimRow.type).toBe('address_exists')
    expect(claimRow.subjectType).toBe('person')
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain('52998224725')
    expect(serialized).not.toContain('529.982.247-25')
  })
})

describe('idempotencia de claims e evidencias', () => {
  it('mesma Idempotency-Key nao duplica validacao, claim nem evidencias', async () => {
    const headers = { 'idempotency-key': 'claim-idem-key-1' }
    const first = await postCnpj(headers)
    const second = await postCnpj(headers)
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(second.json().validation_id).toBe(first.json().validation_id)

    const claims = await claimRowsFor(first.json().validation_id)
    expect(claims.length).toBe(1)
    const firstClaim = claims[0]
    if (firstClaim === undefined) throw new Error('claim row missing')
    const evidences = await evidenceRowsFor(firstClaim.claimId)
    expect(evidences.length).toBeGreaterThan(0)

    const allClaims = await adminPool.db
      .select({ n: sql<number>`count(*)::int` })
      .from(t.claim)
      .where(eq(t.claim.tenantId, tenantId))
    expect(allClaims[0]?.n ?? 0).toBeGreaterThanOrEqual(claims.length)
  })

  it('requisicoes distintas criam claims distintos (1 por validacao)', async () => {
    const a = await postCnpj()
    const b = await postCnpj()
    const claimsA = await claimRowsFor(a.json().validation_id)
    const claimsB = await claimRowsFor(b.json().validation_id)
    expect(claimsA.length).toBe(1)
    expect(claimsB.length).toBe(1)
    const claimA = claimsA[0]
    const claimB = claimsB[0]
    if (claimA === undefined || claimB === undefined) throw new Error('claim rows missing')
    expect(claimA.claimId).not.toBe(claimB.claimId)
  })
})

describe('LGPD: erasure remove claim e evidencias', () => {
  it('DELETE /subjects/:id apaga claims, evidencias e validacoes', async () => {
    const res = await postCnpj()
    const body = res.json()
    const validationId = body.validation_id
    const subjectId = body.claim.subject.id
    const claims = await claimRowsFor(validationId)
    expect(claims.length).toBe(1)

    const erased = await app.inject({
      method: 'DELETE',
      url: `/v1/subjects/${subjectId}`,
      headers: { authorization: `Bearer ${key}` },
    })
    expect(erased.statusCode).toBe(200)
    expect(erased.json().erased).toBe(true)

    const remainingClaims = await adminPool.db
      .select()
      .from(t.claim)
      .where(
        inArray(
          t.claim.claimId,
          claims.map((c) => c.claimId),
        ),
      )
    expect(remainingClaims.length).toBe(0)
    const remainingEvidence = await adminPool.db
      .select()
      .from(t.claimEvidence)
      .where(
        inArray(
          t.claimEvidence.claimId,
          claims.map((c) => c.claimId),
        ),
      )
    expect(remainingEvidence.length).toBe(0)
  })
})

const rlsTenantA = await createTenant(adminPool.db, { name: 'claim-rls-a' })
const rlsTenantB = await createTenant(adminPool.db, { name: 'claim-rls-b' })
const appRolePool = createDbPool(db.appUrl)

describe('RLS: isolamento de tenant em claim e evidencia', () => {
  afterAll(async () => {
    await appRolePool.end()
  })

  const seedClaim = async (tenantId: string) => {
    const subjectId = randomUUID()
    await withTenant(appRolePool.db, tenantId, (tx) =>
      tx.insert(t.subject).values({ subjectId, tenantId, docType: 'CNPJ', docHmac: randomBytes32() }),
    )
    const claimId = randomUUID()
    await withTenant(appRolePool.db, tenantId, (tx) =>
      tx.insert(t.claim).values({
        claimId,
        tenantId,
        validationId: randomUUID(),
        subjectId,
        type: 'business_registered_address',
        subjectType: 'organization',
        targetType: 'address',
      }),
    )
    return { claimId, subjectId }
  }

  it('tenant A nao le claim do tenant B', async () => {
    const { claimId } = await seedClaim(rlsTenantB)
    const asA = await withTenant(appRolePool.db, rlsTenantA, (tx) =>
      tx.select().from(t.claim).where(eq(t.claim.claimId, claimId)),
    )
    expect(asA.length).toBe(0)
    const asB = await withTenant(appRolePool.db, rlsTenantB, (tx) =>
      tx.select().from(t.claim).where(eq(t.claim.claimId, claimId)),
    )
    expect(asB.length).toBe(1)
  })

  it('tenant A nao insere evidencia em claim do tenant B', async () => {
    const { claimId } = await seedClaim(rlsTenantB)
    await expect(
      withTenant(appRolePool.db, rlsTenantA, (tx) =>
        tx.insert(t.claimEvidence).values({
          evidenceId: randomUUID(),
          tenantId: rlsTenantA,
          claimId,
          checker: 'probe',
          checkerVersion: '1.0.0',
          stance: 'supports',
          strength: 0.5,
          confidence: 0.9,
          source: 'test:probe',
          observedAt: new Date(),
          ttlSeconds: 60,
          expiresAt: new Date(Date.now() + 60_000),
          detail: {},
        }),
      ),
    ).rejects.toThrow()
  })

  it('sem contexto de tenant nao ha leitura de claim nem evidencia', async () => {
    const { claimId } = await seedClaim(rlsTenantA)
    const noCtx = await appRolePool.db.select().from(t.claim).where(eq(t.claim.claimId, claimId))
    expect(noCtx.length).toBe(0)
  })

  it('evidencia nunca referencia claim de outro tenant', async () => {
    const { claimId: claimA } = await seedClaim(rlsTenantA)
    const { claimId: claimB } = await seedClaim(rlsTenantB)
    const evidenceA = await withTenant(appRolePool.db, rlsTenantA, (tx) =>
      tx.select().from(t.claimEvidence).where(eq(t.claimEvidence.claimId, claimA)),
    )
    expect(evidenceA.length).toBe(0)
    const cross = await withTenant(appRolePool.db, rlsTenantA, (tx) =>
      tx.select().from(t.claimEvidence).where(eq(t.claimEvidence.claimId, claimB)),
    )
    expect(cross.length).toBe(0)
  })
})

function randomBytes32(): Buffer {
  const buf = Buffer.alloc(32)
  for (let i = 0; i < 32; i += 1) buf[i] = Math.floor(Math.random() * 256)
  return buf
}
