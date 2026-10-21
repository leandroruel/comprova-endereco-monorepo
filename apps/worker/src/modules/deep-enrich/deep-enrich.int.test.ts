import {
  createIssuerSigningKey,
  createTenant,
  createTestCredentialSigningKey,
  seedGoldenDataset,
  signingKeysConfig,
  startTestDb,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
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
import {
  DEFAULT_CREDENTIAL_TTL_SECONDS,
  loadPolicy,
  policyHashOf,
  systemClock,
  type Clock,
  type PartnerGraphReader,
} from '@comprova/core'
import {
  credentialIdOf,
  issuerScopeOf,
  localIssuer,
  verificationMethodOf,
  verifyCredentialIntegrity,
} from '@comprova/credential'
import { makePartnerGraph, makeT0Checkers, makeT1Checkers } from '@comprova/checkers'
import { makeFakeGeocoder, makeFailingGeocoder, makeFakePlaces, makeFailingPlaces } from '@comprova/providers'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { deepEnrich } from './deep-enrich.service.js'
import { runFastPath } from '../../../../api/src/services/fastpath.js'
import { issueCredential } from '../../../../api/src/services/credential-issuer.js'
import { makeConfiguredSigningKeyProvider } from '../../../../api/src/services/signing-key-provider.js'

/** Origem de teste (TLD reservado), como no resto da suíte. */
const ISSUER_ORIGIN = 'https://issuer.test'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../../../../')

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
await seedGoldenDataset(adminPool.db)
const tenant = await createTenant(adminPool.db, { name: 'deep-tenant' })

// Chave de assinatura do tenant (FASE 14): o material privado vive no resolver
// em memória; só a chave pública é registrada em `issuer_signing_key`.
const signing = createTestCredentialSigningKey('key-1')
await createIssuerSigningKey(adminPool.db, tenant, signing)
const signingKeyProvider = makeConfiguredSigningKeyProvider(
  signingKeysConfig([{ tenantId: tenant, key: signing }]),
)
const issuer = localIssuer(ISSUER_ORIGIN, tenant, signing.keyId)
const trusted = { id: verificationMethodOf(issuer), publicKey: signing.publicKey }

const policyYaml = readFileSync(path.join(repoRoot, 'policies', '2026.11.1.yaml'), 'utf8')
const policy = loadPolicy(policyYaml)
const policyHash = policyHashOf(policyYaml)

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
  policyHash: policyHashOf(policyYaml),
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
      { tenantId: tenant, apiKeyId: null },
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
      { db: adminPool.db, t1Checkers: t1WithFakes, policy, policyHash, clock: systemClock },
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
      { tenantId: tenant, apiKeyId: null },
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
      { db: adminPool.db, t1Checkers: t1Chaos, policy, policyHash, clock: systemClock },
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

  // Fase 14 — evidências históricas jamais são sobrescritas: nova observação → nova
  // evidência. Reexecutar o enriquecimento anexa (append-only) e o replay não muta
  // nem duplica linhas existentes.
  it('Fase 14 — claim_evidence é append-only e imutável entre execuções', async () => {
    const created = await runFastPath(
      fastPathDeps,
      { tenantId: tenant, apiKeyId: null },
      {
        documentType: 'CNPJ',
        documentValue: '12345678000195',
        addressInput: null,
        legalBasis: 'FRAUD_PREVENTION',
        mode: 'auto',
        idempotencyKey: 'fase14-immutability',
      },
    )

    const claimRows = await adminPool.db
      .select({ claimId: t.claim.claimId })
      .from(t.claim)
      .where(eq(t.claim.validationId, created.validationId))
    const claimId = claimRows[0]?.claimId
    expect(claimId).toBeDefined()
    if (claimId === undefined) throw new Error('claim nao criado pelo fast path')

    const snapshot = async (): Promise<
      readonly {
        claimEvidenceId: string
        evidenceId: string | null
        signalId: string | null
        checker: string
        checkerVersion: string
        stance: string
        strength: number
        confidence: number
        source: string
        observedAt: Date
        ttlSeconds: number
        detail: Record<string, unknown>
      }[]
    > =>
      adminPool.db
        .select({
          claimEvidenceId: t.claimEvidence.claimEvidenceId,
          evidenceId: t.claimEvidence.evidenceId,
          signalId: t.claimEvidence.signalId,
          checker: t.claimEvidence.checker,
          checkerVersion: t.claimEvidence.checkerVersion,
          stance: t.claimEvidence.stance,
          strength: t.claimEvidence.strength,
          confidence: t.claimEvidence.confidence,
          source: t.claimEvidence.source,
          observedAt: t.claimEvidence.observedAt,
          ttlSeconds: t.claimEvidence.ttlSeconds,
          detail: t.claimEvidence.detail,
        })
        .from(t.claimEvidence)
        .where(eq(t.claimEvidence.claimId, claimId))
        .orderBy(t.claimEvidence.claimEvidenceId)

    const afterFast = await snapshot()
    expect(afterFast.length).toBeGreaterThan(0)

    await deepEnrich(
      { db: adminPool.db, t1Checkers: t1WithFakes, policy, policyHash, clock: systemClock },
      { tenantId: tenant, validationId: created.validationId },
    )
    const afterFirstDeep = await snapshot()

    // T1 anexou novas evidências (append-only)...
    expect(afterFirstDeep.length).toBeGreaterThan(afterFast.length)
    // ...sem tocar nas evidências do fast path.
    for (const before of afterFast) {
      const after = afterFirstDeep.find((r) => r.claimEvidenceId === before.claimEvidenceId)
      expect(after, `evidence ${before.claimEvidenceId} deve permanecer intacta`).toEqual(before)
    }
    // Nunca há evidência duplicada (ids únicos).
    expect(new Set(afterFirstDeep.map((r) => r.claimEvidenceId)).size).toBe(afterFirstDeep.length)

    // Replay: nova execução não muta nem duplica as evidências já persistidas.
    await deepEnrich(
      { db: adminPool.db, t1Checkers: t1WithFakes, policy, policyHash, clock: systemClock },
      { tenantId: tenant, validationId: created.validationId },
    )
    const afterReplay = await snapshot()
    expect(afterReplay).toEqual(afterFirstDeep)
  })

  // FASE 7 — validação legada (signals já persistidos, sem claim) recebe claim e
  // claim_evidence para TODOS os seus signals, de forma idempotente.
  it('Fase 7 — cria claim e claim_evidence para validação sem claim (legado)', async () => {
    const created = await runFastPath(
      fastPathDeps,
      { tenantId: tenant, apiKeyId: null },
      {
        documentType: 'CNPJ',
        documentValue: '12345678000195',
        addressInput: null,
        legalBasis: 'FRAUD_PREVENTION',
        mode: 'auto',
        idempotencyKey: 'fase7-legacy',
      },
    )
    const claimRows = await adminPool.db
      .select({ claimId: t.claim.claimId })
      .from(t.claim)
      .where(eq(t.claim.validationId, created.validationId))
    const oldClaimId = claimRows[0]?.claimId
    if (oldClaimId === undefined) throw new Error('claim nao criado pelo fast path')

    // Simula uma validação criada ANTES do modelo claim.
    await adminPool.db.delete(t.claimEvidence).where(eq(t.claimEvidence.claimId, oldClaimId))
    await adminPool.db.delete(t.claim).where(eq(t.claim.claimId, oldClaimId))

    const prior = await adminPool.db
      .select({ signalId: t.signal.signalId })
      .from(t.signal)
      .where(eq(t.signal.validationId, created.validationId))
    expect(prior.length).toBeGreaterThan(0)

    await deepEnrich(
      { db: adminPool.db, t1Checkers: t1WithFakes, policy, policyHash, clock: systemClock },
      { tenantId: tenant, validationId: created.validationId },
    )

    const recreated = await adminPool.db
      .select({ claimId: t.claim.claimId })
      .from(t.claim)
      .where(eq(t.claim.validationId, created.validationId))
    expect(recreated.length).toBe(1)
    const newClaimId = recreated[0]?.claimId
    if (newClaimId === undefined) throw new Error('claim nao recriado')

    const allSignals = await adminPool.db
      .select({ signalId: t.signal.signalId })
      .from(t.signal)
      .where(eq(t.signal.validationId, created.validationId))
    const evidences = await adminPool.db
      .select({ signalId: t.claimEvidence.signalId })
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimId, newClaimId))
    const covered = new Set(evidences.map((row) => row.signalId))
    for (const s of allSignals) expect(covered.has(s.signalId)).toBe(true)

    // Replay não duplica observações.
    await deepEnrich(
      { db: adminPool.db, t1Checkers: t1WithFakes, policy, policyHash, clock: systemClock },
      { tenantId: tenant, validationId: created.validationId },
    )
    const after = await adminPool.db
      .select({ claimEvidenceId: t.claimEvidence.claimEvidenceId })
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimId, newClaimId))
    expect(after.length).toBe(evidences.length)
  })

  // FASE 19 — claim_evidence pode referenciar um artefato material (`evidence`)
  // de forma OPCIONAL, mas nunca um id inexistente (integridade referencial).
  it('Fase 19 — claim_evidence vincula artefato material opcional (evidence)', async () => {
    const created = await runFastPath(
      fastPathDeps,
      { tenantId: tenant, apiKeyId: null },
      {
        documentType: 'CNPJ',
        documentValue: '12345678000195',
        addressInput: null,
        legalBasis: 'FRAUD_PREVENTION',
        mode: 'fast',
        idempotencyKey: 'fase19-material',
      },
    )
    const claimRows = await adminPool.db
      .select({ claimId: t.claim.claimId })
      .from(t.claim)
      .where(eq(t.claim.validationId, created.validationId))
    const claimId = claimRows[0]?.claimId
    if (claimId === undefined) throw new Error('claim row missing')

    // Fast path (T0) não produz artefato material → evidence_id nulo.
    const fastEvidence = await adminPool.db
      .select({ evidenceId: t.claimEvidence.evidenceId })
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimId, claimId))
    expect(fastEvidence.length).toBeGreaterThan(0)
    expect(fastEvidence.every((e) => e.evidenceId === null)).toBe(true)

    const materialId = randomUUID()
    await adminPool.db.insert(t.evidence).values({
      evidenceId: materialId,
      kind: 'image',
      provider: 'street_view',
      s3Uri: 's3://comprova-evidence/probe.jpg',
      sha256: Buffer.alloc(32),
      capturedAt: new Date(),
      retentionUntil: new Date(Date.now() + 86_400_000),
    })
    const linkedId = randomUUID()
    await adminPool.db.insert(t.claimEvidence).values({
      claimEvidenceId: linkedId,
      tenantId: tenant,
      claimId,
      signalId: null,
      evidenceId: materialId,
      evidenceSha256: Buffer.alloc(32),
      checker: 'street_view_vlm',
      checkerVersion: '1.0.0',
      stance: 'supports',
      strength: 0.8,
      confidence: 0.9,
      source: 'street_view',
      observedAt: new Date(),
      ttlSeconds: 3600,
      expiresAt: new Date(Date.now() + 3_600_000),
      detail: {},
    })
    const readBack = await adminPool.db
      .select({ evidenceId: t.claimEvidence.evidenceId })
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimEvidenceId, linkedId))
    expect(readBack[0]?.evidenceId).toBe(materialId)

    // FK garante que não há referência órfã a artefato inexistente.
    await expect(
      adminPool.db.insert(t.claimEvidence).values({
        claimEvidenceId: randomUUID(),
        tenantId: tenant,
        claimId,
        evidenceId: randomUUID(),
        checker: 'probe',
        checkerVersion: '1.0.0',
        stance: 'unknown',
        strength: 0,
        confidence: 1,
        source: 'test',
        observedAt: new Date(),
        ttlSeconds: 60,
        expiresAt: new Date(Date.now() + 60_000),
        detail: {},
      }),
    ).rejects.toThrow()
  })

  // BAIXO-8: `signal.evidence_id` legado (aponta para `claim_evidence_id`, não
  // para `evidence`) NÃO deve ser propagado no backfill — só ids materiais reais.
  it('Fase 19/BAIXO-8 — backfill não propaga signal.evidence_id legado', async () => {
    const created = await runFastPath(
      fastPathDeps,
      { tenantId: tenant, apiKeyId: null },
      {
        documentType: 'CNPJ',
        documentValue: '12345678000195',
        addressInput: null,
        legalBasis: 'FRAUD_PREVENTION',
        mode: 'fast',
        idempotencyKey: 'baixo8-legacy',
      },
    )
    const claimRows = await adminPool.db
      .select({ claimId: t.claim.claimId })
      .from(t.claim)
      .where(eq(t.claim.validationId, created.validationId))
    const claimId = claimRows[0]?.claimId
    if (claimId === undefined) throw new Error('claim row missing')

    // Um id que existe em `claim_evidence` (semântica legada), mas NÃO em `evidence`.
    const existing = await adminPool.db
      .select({ claimEvidenceId: t.claimEvidence.claimEvidenceId })
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimId, claimId))
      .limit(1)
    const legacyEvidenceId = existing[0]?.claimEvidenceId
    if (legacyEvidenceId === undefined) throw new Error('claim_evidence row missing')

    // Signal legado, SEM claim_evidence, com `evidence_id` "envenenado".
    const legacySignalId = randomUUID()
    await adminPool.db.insert(t.signal).values({
      signalId: legacySignalId,
      validationId: created.validationId,
      checkerId: 'legacy_checker',
      checkerVersion: '0.0.1',
      stance: 'supports',
      strength: 0.4,
      confidence: 0.5,
      source: 'legacy',
      observedAt: new Date(),
      ttlSeconds: 3600,
      detail: {},
      evidenceId: legacyEvidenceId,
    })

    // Não deve lançar (sem a correção, a FK rejeitaria o id legado).
    await deepEnrich(
      { db: adminPool.db, t1Checkers: t1WithFakes, policy, policyHash, clock: systemClock },
      { tenantId: tenant, validationId: created.validationId },
    )

    const backfilled = await adminPool.db
      .select({ evidenceId: t.claimEvidence.evidenceId })
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.signalId, legacySignalId))
    expect(backfilled.length).toBe(1)
    expect(backfilled[0]?.evidenceId).toBeNull()
  })

  // Fase 24 (ADR-0024 §5) — relógio controlado: `deepEnrich` pode levar minutos
  // nos verificadores, então `completed_at` precisa ser lido no FIM (quando o
  // resultado terminal fica pronto), nunca reaproveitando o instante de avaliação
  // capturado no início do processamento. E é o instante da PRIMEIRA conclusão
  // terminal: replay do mesmo resultado preserva, conclusão nova grava novo.
  describe('Fase 24 — instante de conclusão do deep path', () => {
    const T0 = new Date('2026-06-01T00:00:00.000Z')
    const T1 = new Date('2026-06-01T00:07:00.000Z')

    /** Relógio que avançou durante o processamento: 1ª leitura = T0, demais = T1. */
    const advancingClock = (): Clock => {
      let reads = 0
      return { now: () => (reads++ === 0 ? T0 : T1) }
    }

    const validationRow = async (validationId: string) =>
      (await adminPool.db.select().from(t.validation).where(eq(t.validation.validationId, validationId)))[0]

    const issuanceOf = async (validationId: string) =>
      (
        await adminPool.db
          .select({
            credentialId: t.credentialIssuance.credentialId,
            issuedAt: t.credentialIssuance.issuedAt,
          })
          .from(t.credentialIssuance)
          .where(eq(t.credentialIssuance.validationId, validationId))
      )[0]

    const statusOf = async (validationId: string) => {
      const issuance = await issuanceOf(validationId)
      if (issuance === undefined) return undefined
      return (
        await adminPool.db
          .select()
          .from(t.credentialStatus)
          .where(eq(t.credentialStatus.credentialId, issuance.credentialId))
      )[0]
    }

    const createQueued = async (idempotencyKey: string, documentValue: string): Promise<string> => {
      // `created_at` = T0: a validação nasce em `queued` (fast path) no instante
      // do pedido; o enriquecimento profundo acontece depois.
      const created = await runFastPath(
        { ...fastPathDeps, clock: { now: () => T0 } },
        { tenantId: tenant, apiKeyId: null },
        {
          documentType: 'CNPJ',
          documentValue,
          addressInput: null,
          legalBasis: 'FRAUD_PREVENTION',
          mode: 'deep',
          idempotencyKey,
        },
      )
      expect(created.status).toBe('queued')
      return created.validationId
    }

    it('registra a conclusão real (T1) e emite credencial com validFrom = completed_at', async () => {
      const validationId = await createQueued('fase24-completion', '12345678000195')

      const before = await validationRow(validationId)
      expect(before?.createdAt?.toISOString()).toBe(T0.toISOString())
      // Nada de `completed_at` antecipado: a validação ainda não concluiu.
      expect(before?.status).toBe('queued')
      expect(before?.completedAt).toBeNull()

      const result = await deepEnrich(
        { db: adminPool.db, t1Checkers: t1WithFakes, policy, policyHash, clock: advancingClock() },
        { tenantId: tenant, validationId },
      )
      expect(result.status).toBe('completed')

      const after = await validationRow(validationId)
      expect(after?.status).toBe('completed')
      // `created_at` continua sendo o início da validação (T0)...
      expect(after?.createdAt?.toISOString()).toBe(T0.toISOString())
      // ...e `completed_at` é a conclusão dos verificadores (T1), não o início.
      expect(after?.completedAt?.toISOString()).toBe(T1.toISOString())
      expect(after!.completedAt!.getTime()).toBeGreaterThan(after!.createdAt!.getTime())

      // A credencial daí derivada usa o instante de conclusão como `validFrom`.
      const credential = await issueCredential(adminPool.db, tenant, validationId, {
        issuerOrigin: ISSUER_ORIGIN,
        signingKeyProvider,
      })

      expect(credential.validFrom).toBe(T1.toISOString())
      expect(credential.validFrom).not.toBe(T0.toISOString())
      expect(credential['comprova:result']['comprova:completedAt']).toBe(T1.toISOString())
      // `validUntil` = min(completed_at + policy TTL, observed_at + ttl_seconds);
      // NÃO é o `expires_at` de retenção.
      const claimRows = await adminPool.db
        .select({ claimId: t.claim.claimId })
        .from(t.claim)
        .where(eq(t.claim.validationId, validationId))
        .limit(1)
      const claimId = claimRows[0]?.claimId
      if (claimId === undefined) throw new Error('claim missing')
      const evidence = await adminPool.db
        .select({ observedAt: t.claimEvidence.observedAt, ttlSeconds: t.claimEvidence.ttlSeconds })
        .from(t.claimEvidence)
        .where(eq(t.claimEvidence.claimId, claimId))
      const expectedValidUntil = new Date(
        Math.min(
          T1.getTime() + DEFAULT_CREDENTIAL_TTL_SECONDS * 1000,
          ...evidence.map((e) => e.observedAt.getTime() + e.ttlSeconds * 1000),
        ),
      )
      expect(credential.validUntil).toBe(expectedValidUntil.toISOString())
      expect(verifyCredentialIntegrity(credential, { trusted })).toMatchObject({ valid: true })
    })

    it('replay do mesmo resultado terminal preserva o `completed_at` original', async () => {
      const validationId = await createQueued('fase24-replay', '12345678000195')

      const first = await deepEnrich(
        { db: adminPool.db, t1Checkers: t1WithFakes, policy, policyHash, clock: advancingClock() },
        { tenantId: tenant, validationId },
      )
      expect(first.status).toBe('completed')
      expect((await validationRow(validationId))?.completedAt?.toISOString()).toBe(T1.toISOString())

      // Emite a credencial ANTES do replay: o replay idêntico não pode revogá-la.
      const issued = await issueCredential(adminPool.db, tenant, validationId, {
        issuerOrigin: ISSUER_ORIGIN,
        signingKeyProvider,
      })
      expect(issued.validFrom).toBe(T1.toISOString())
      expect((await statusOf(validationId))?.status).toBe('ACTIVE')

      // Retry/replay do worker (mesma policy, mesmos verificadores, mesmas
      // evidências): reexecutar NÃO é reconcluir. O `completed_at` original é
      // preservado — avançá-lo mudaria o `validFrom` de credenciais emitidas
      // depois sem nenhuma conclusão nova (ADR-0024 §5).
      const T2 = new Date('2026-06-01T00:11:00.000Z')
      const replay = await deepEnrich(
        { db: adminPool.db, t1Checkers: t1WithFakes, policy, policyHash, clock: { now: () => T2 } },
        { tenantId: tenant, validationId },
      )
      expect(replay.status).toBe('completed')

      const row = await validationRow(validationId)
      expect(row?.status).toBe('completed')
      expect(row?.completedAt?.toISOString()).toBe(T1.toISOString())

      // Replay idêntico NÃO revoga: a credencial continua ACTIVE.
      const statusAfterReplay = await statusOf(validationId)
      expect(statusAfterReplay?.status).toBe('ACTIVE')
      expect(statusAfterReplay?.revokedAt).toBeNull()
      expect(statusAfterReplay?.revocationReason).toBeNull()

      // A credencial emitida depois do replay continua ancorada na conclusão
      // original — e continua verificável.
      const credential = await issueCredential(adminPool.db, tenant, validationId, {
        issuerOrigin: ISSUER_ORIGIN,
        signingKeyProvider,
      })
      expect(credential.validFrom).toBe(T1.toISOString())
      expect(credential['comprova:result']['comprova:completedAt']).toBe(T1.toISOString())
      expect(verifyCredentialIntegrity(credential, { trusted })).toMatchObject({ valid: true })
    })

    it('mudança de policy_hash é uma NOVA conclusão, mesmo com veredito e evidências iguais', async () => {
      const validationId = await createQueued('fase24-policy', '12345678000195')

      const first = await deepEnrich(
        { db: adminPool.db, t1Checkers: t1WithFakes, policy, policyHash, clock: advancingClock() },
        { tenantId: tenant, validationId },
      )
      expect(first.status).toBe('completed')
      expect((await validationRow(validationId))?.completedAt?.toISOString()).toBe(T1.toISOString())

      // Credencial emitida sob a conclusão original: fica ACTIVE.
      await issueCredential(adminPool.db, tenant, validationId, {
        issuerOrigin: ISSUER_ORIGIN,
        signingKeyProvider,
      })
      expect((await statusOf(validationId))?.status).toBe('ACTIVE')

      // Mesma policy em memória (mesmo veredito/evidências), mas o digest
      // efetivo mudou: é uma avaliação sob outra policy, logo uma conclusão
      // nova. O `completed_at` não pode ser preservado.
      const T2 = new Date('2026-06-01T00:21:00.000Z')
      const changedPolicyHash = 'f'.repeat(64)
      const replay = await deepEnrich(
        {
          db: adminPool.db,
          t1Checkers: t1WithFakes,
          policy,
          policyHash: changedPolicyHash,
          clock: { now: () => T2 },
        },
        { tenantId: tenant, validationId },
      )
      expect(replay.status).toBe('completed')
      expect(replay.verdict).toBe(first.verdict)

      const row = await validationRow(validationId)
      expect(row?.completedAt?.toISOString()).toBe(T2.toISOString())

      // C1: a credencial antiga foi revogada como `superseded`, na mesma
      // transação da nova conclusão.
      const superseded = await statusOf(validationId)
      expect(superseded?.status).toBe('REVOKED')
      expect(superseded?.revocationReason).toBe('superseded')
      expect(superseded?.revokedAt).not.toBeNull()

      // Reexecução idêntica (mesmo policy_hash novo) não reescreve a revogação.
      const T3 = new Date('2026-06-01T00:31:00.000Z')
      await deepEnrich(
        {
          db: adminPool.db,
          t1Checkers: t1WithFakes,
          policy,
          policyHash: changedPolicyHash,
          clock: { now: () => T3 },
        },
        { tenantId: tenant, validationId },
      )
      const stillSuperseded = await statusOf(validationId)
      expect(stillSuperseded?.status).toBe('REVOKED')
      expect(stillSuperseded?.revocationReason).toBe('superseded')
      expect(stillSuperseded?.revokedAt?.toISOString()).toBe(superseded?.revokedAt?.toISOString())
      // E o replay idêntico sob a policy nova preserva a conclusão que já
      // refletia essa policy (não é uma terceira conclusão).
      expect((await validationRow(validationId))?.completedAt?.toISOString()).toBe(T2.toISOString())
    })

    it('policy nova sem credencial antiga: replay idêntico não revoga a credencial emitida depois', async () => {
      const validationId = await createQueued('fase24-policy-no-old-credential', '12345678000195')

      // Conclusão sob a policy original, mas SEM emitir credencial ainda.
      const first = await deepEnrich(
        { db: adminPool.db, t1Checkers: t1WithFakes, policy, policyHash, clock: advancingClock() },
        { tenantId: tenant, validationId },
      )
      expect(first.status).toBe('completed')
      expect((await validationRow(validationId))?.completedAt?.toISOString()).toBe(T1.toISOString())

      // Primeira reavaliação sob a policy nova: nova conclusão, sem nada a
      // revogar porque não havia credencial.
      const T2 = new Date('2026-06-01T00:22:00.000Z')
      const changedPolicyHash = 'e'.repeat(64)
      await deepEnrich(
        {
          db: adminPool.db,
          t1Checkers: t1WithFakes,
          policy,
          policyHash: changedPolicyHash,
          clock: { now: () => T2 },
        },
        { tenantId: tenant, validationId },
      )
      expect((await validationRow(validationId))?.completedAt?.toISOString()).toBe(T2.toISOString())

      // A credencial é emitida DEPOIS da mudança de policy. Ela é a primeira
      // emissão desta validation e fica ACTIVE.
      await issueCredential(adminPool.db, tenant, validationId, {
        issuerOrigin: ISSUER_ORIGIN,
        signingKeyProvider,
      })
      expect((await statusOf(validationId))?.status).toBe('ACTIVE')

      // Replay IDÊNTICO sob a mesma policy nova: não é uma conclusão nova e não
      // pode revogar a credencial recém-emitida.
      const T3 = new Date('2026-06-01T00:32:00.000Z')
      await deepEnrich(
        {
          db: adminPool.db,
          t1Checkers: t1WithFakes,
          policy,
          policyHash: changedPolicyHash,
          clock: { now: () => T3 },
        },
        { tenantId: tenant, validationId },
      )
      expect((await validationRow(validationId))?.completedAt?.toISOString()).toBe(T2.toISOString())
      const status = await statusOf(validationId)
      expect(status?.status).toBe('ACTIVE')
      expect(status?.revokedAt).toBeNull()
      expect(status?.revocationReason).toBeNull()
    })

    it('reexecução com evidências novas é uma NOVA conclusão: grava novo instante', async () => {
      const validationId = await createQueued('fase24-drift', '12345678000195')

      // 1ª conclusão com um subconjunto dos verificadores T1.
      const geocodeOnly = t1WithFakes.filter((checker) => checker.id === 'geocode_consensus')
      const first = await deepEnrich(
        { db: adminPool.db, t1Checkers: geocodeOnly, policy, policyHash, clock: advancingClock() },
        { tenantId: tenant, validationId },
      )
      expect(first.status).toBe('completed')
      const firstRow = await validationRow(validationId)
      expect(firstRow?.completedAt?.toISOString()).toBe(T1.toISOString())

      // Nova execução com MAIS verificadores: mesmo veredito, mas o conjunto de
      // evidências muda — o resultado terminal recomputado é uma conclusão NOVA
      // e recebe o instante atual. Preservar o instante antigo anteciparia a
      // existência de conteúdo que só passou a existir na reexecução.
      const partnerGraphUnknown: PartnerGraphReader = {
        statsFor: async () => ({
          coLocatedCnpjs: 0,
          cnpjsSharingPartner: 0,
          recentOpeningsAtAddress: 0,
          hasData: true,
        }),
      }
      const T2 = new Date('2026-06-01T00:11:00.000Z')
      const second = await deepEnrich(
        {
          db: adminPool.db,
          t1Checkers: [...t1WithFakes, makePartnerGraph(partnerGraphUnknown)],
          policy,
          policyHash,
          clock: { now: () => T2 },
        },
        { tenantId: tenant, validationId },
      )
      expect(second.status).toBe('completed')
      expect(second.verdict).toBe(first.verdict)

      const secondRow = await validationRow(validationId)
      expect(secondRow?.evidenceSetHash).not.toBe(firstRow?.evidenceSetHash)
      expect(secondRow?.completedAt?.toISOString()).toBe(T2.toISOString())
    })

    it('voltar a parcial depois de concluída revoga a credencial como `superseded`', async () => {
      const validationId = await createQueued('fase24-partial-after-complete', '90123456000131')

      // Simula uma conclusão anterior com credencial já emitida. A validação
      // nasce `queued` (sem claim/evidência para emitir), então a linha de
      // conclusão e a emissão são montadas diretamente; o que importa para C1 é
      // que a PRÓXIMA execução veja `previous.status = completed`.
      await adminPool.db
        .update(t.validation)
        .set({ status: 'completed', completedAt: T1 })
        .where(eq(t.validation.validationId, validationId))
      const issuerScope = issuerScopeOf(tenant)
      const credentialId = credentialIdOf(issuer.id, validationId)
      await adminPool.db.insert(t.credentialIssuance).values({
        validationId,
        tenantId: tenant,
        issuerScope,
        credentialId,
        issuedAt: T1,
      })
      await adminPool.db.insert(t.credentialStatus).values({
        credentialId,
        tenantId: tenant,
        issuerScope,
        status: 'ACTIVE',
      })

      const T2 = new Date('2026-06-01T00:25:00.000Z')
      const result = await deepEnrich(
        { db: adminPool.db, t1Checkers: t1Chaos, policy, policyHash, clock: { now: () => T2 } },
        { tenantId: tenant, validationId },
      )
      expect(result.status).toBe('partial')

      const row = await validationRow(validationId)
      expect(row?.status).toBe('partial')
      expect(row?.completedAt).toBeNull()

      const status = await statusOf(validationId)
      expect(status?.status).toBe('REVOKED')
      expect(status?.revocationReason).toBe('superseded')
    })

    it('resultado parcial (e seu replay) permanece sem `completed_at`', async () => {
      const validationId = await createQueued('fase24-partial', '90123456000131')

      for (const run of [1, 2]) {
        const result = await deepEnrich(
          { db: adminPool.db, t1Checkers: t1Chaos, policy, policyHash, clock: advancingClock() },
          { tenantId: tenant, validationId },
        )
        expect(result.status, `execução ${run}`).toBe('partial')

        const row = await validationRow(validationId)
        expect(row?.status, `execução ${run}`).toBe('partial')
        // Parcial não é conclusão: `completed_at` continua NULL, sem timestamp
        // indevido (inclusive no reprocessamento).
        expect(row?.completedAt, `execução ${run}`).toBeNull()
        expect(row?.createdAt?.toISOString()).toBe(T0.toISOString())
      }
    })
  })
})
