import { createLogger, createMetrics } from '@comprova/observability'
import { createDbPool, eq, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import { evidenceSetHashOfObservations, policyHashOf, SCORER_VERSION } from '@comprova/core'
import {
  generateEd25519KeyPair,
  localIssuer,
  makeEd25519Signer,
  verificationMethodOf,
  verifyCredential,
  type SecuredVerifiableCredential,
} from '@comprova/credential'
import {
  createApiKey,
  createSubject,
  createTenant,
  seedGoldenDataset,
  startTestDb,
  startTestRedis,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import Redis from 'ioredis'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import type { AppConfig } from './config.js'
import { CredentialIssuanceError, issueCredential } from './services/credential-issuer.js'

// FASE 12 — ponta a ponta: validation persistida → credential builder → credencial
// assinada → JSON transportável → verifier independente → VALID. Também cobre a
// independência do material físico (retenção) e a recusa de emissão parcial.

const PEPPER = 'test-pepper-credential'
const POLICY_VERSION = '2026.13.1'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const policyYaml = readFileSync(path.join(repoRoot, 'policies', `${POLICY_VERSION}.yaml`), 'utf8')

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
await seedGoldenDataset(adminPool.db)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

const tenantId = await createTenant(adminPool.db, { name: 'credential-tenant' })
const key = await createApiKey(adminPool.db, tenantId, PEPPER, {
  scopes: ['validate:read', 'validate:write'],
})

const appPool = createDbPool(db.appUrl)
const config: AppConfig = {
  DATABASE_URL: db.appUrl,
  REDIS_URL: testRedis.url,
  API_KEY_PEPPER: PEPPER,
  PORT: 3000,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  POLICY_VERSION,
  TEMPORAL_ENABLED: false,
  VLM_ENABLED: false,
  TEMPORAL_ADDRESS: 'localhost:7233',
  TEMPORAL_NAMESPACE: 'default',
  TEMPORAL_TASK_QUEUE: 'comprova-deep-t1',
  WORKER_LOOPS: false,
}
const app = await buildApp({
  config,
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

const authJson = { authorization: `Bearer ${key.plaintext}`, 'content-type': 'application/json' }

const postCnpj = () =>
  app.inject({
    method: 'POST',
    url: '/v1/validations',
    headers: authJson,
    payload: {
      document: { type: 'CNPJ', value: '12345678000195' },
      address: null,
      mode: 'fast',
      legal_basis: 'FRAUD_PREVENTION',
    },
  })

const validationRow = async (validationId: string) =>
  (await adminPool.db.select().from(t.validation).where(eq(t.validation.validationId, validationId)))[0]

const claimIdOf = async (validationId: string): Promise<string> => {
  const rows = await adminPool.db
    .select({ claimId: t.claim.claimId })
    .from(t.claim)
    .where(eq(t.claim.validationId, validationId))
  const claimId = rows[0]?.claimId
  if (claimId === undefined) throw new Error('claim row missing')
  return claimId
}

const observationsOf = (claimId: string) =>
  adminPool.db
    .select({
      id: t.claimEvidence.claimEvidenceId,
      checker: t.claimEvidence.checker,
      checkerVersion: t.claimEvidence.checkerVersion,
      stance: t.claimEvidence.stance,
      strength: t.claimEvidence.strength,
      confidence: t.claimEvidence.confidence,
      source: t.claimEvidence.source,
      observedAt: t.claimEvidence.observedAt,
      evidenceSha256: t.claimEvidence.evidenceSha256,
      detail: t.claimEvidence.detail,
    })
    .from(t.claimEvidence)
    .where(eq(t.claimEvidence.claimId, claimId))

const keyPair = generateEd25519KeyPair()
const issuer = localIssuer(tenantId, 'key-1')
const signer = makeEd25519Signer(keyPair.privateKey)

const issue = (validationId: string): Promise<SecuredVerifiableCredential> =>
  issueCredential(appPool.db, tenantId, validationId, { issuer, signer })

const transport = (credential: SecuredVerifiableCredential): SecuredVerifiableCredential =>
  JSON.parse(JSON.stringify(credential)) as SecuredVerifiableCredential

const newValidation = async (): Promise<string> => {
  const res = await postCnpj()
  expect(res.statusCode).toBe(200)
  return res.json().validation_id as string
}

describe('emissão e verificação independente', () => {
  it('transforma uma validation concluída em credencial verificável como JSON puro', async () => {
    const validationId = await newValidation()
    const row = await validationRow(validationId)
    const claimId = await claimIdOf(validationId)
    const observations = await observationsOf(claimId)

    const credential = transport(await issue(validationId))

    expect(observations.length).toBeGreaterThan(0)
    expect(credential['@context'][0]).toBe('https://www.w3.org/ns/credentials/v2')
    expect(credential.type).toEqual(['VerifiableCredential', 'comprova:AddressCredential'])
    expect(credential.issuer).toBe(`comprova:issuer:${tenantId}`)
    expect(credential.credentialSubject['comprova:docType']).toBe('CNPJ')
    expect(credential.credentialSubject.id).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(credential.credentialSubject['comprova:claim'].id).toBe(`urn:uuid:${claimId}`)
    expect(credential.credentialSubject['comprova:claim']['comprova:targetType']).toBe('address')
    expect(credential['comprova:evidenceSetHash']).toBe(row?.evidenceSetHash)
    expect(credential.evidence).toHaveLength(observations.length)
    expect(credential['comprova:evidenceSetHash']).toBe(evidenceSetHashOfObservations(observations))
    expect(credential['comprova:policy']).toEqual({
      'comprova:version': POLICY_VERSION,
      'comprova:hash': policyHashOf(policyYaml),
    })
    expect(credential['comprova:algorithm']).toEqual({ 'comprova:scorerVersion': SCORER_VERSION })
    expect(credential['comprova:result']['comprova:verdict']).toBe(row?.verdict)
    if (row?.completedAt === null) {
      expect(credential['comprova:result']).not.toHaveProperty('comprova:completedAt')
    } else {
      expect(credential['comprova:result']['comprova:completedAt']).toBe(row!.completedAt!.toISOString())
    }
    expect(credential['comprova:authorization']).toEqual({
      'comprova:scopes': ['validate:read', 'validate:write'],
    })

    const subjectRow = (
      await adminPool.db
        .select({ docHmac: t.subject.docHmac })
        .from(t.subject)
        .where(eq(t.subject.subjectId, row!.subjectId))
    )[0]
    expect(JSON.stringify(credential)).not.toContain(subjectRow!.docHmac.toString('hex'))

    // O verifier só recebe a credencial (JSON) e a chave pública.
    expect(
      verifyCredential(credential, {
        publicKey: keyPair.publicKey,
        expectedIssuerId: issuer.id,
        expectedVerificationMethod: verificationMethodOf(issuer),
      }),
    ).toEqual({ valid: true })
  })

  const tamperCases: ReadonlyArray<readonly [string, (credential: SecuredVerifiableCredential) => void]> = [
    ['issuer', (c) => (c.issuer = `comprova:issuer:${randomUUID()}`)],
    ['subject', (c) => (c.credentialSubject.id = `sha256:${'f'.repeat(64)}`)],
    ['claim', (c) => (c.credentialSubject['comprova:claim']['comprova:claimType'] = 'address_exists')],
    [
      'target_type',
      (c) =>
        ((c.credentialSubject['comprova:claim'] as Record<string, unknown>)['comprova:targetType'] =
          'parcel'),
    ],
    [
      'address',
      (c) => (c.credentialSubject['comprova:claim']['comprova:address'].id = `urn:uuid:${randomUUID()}`),
    ],
    [
      'building_key',
      (c) => (c.credentialSubject['comprova:claim']['comprova:address']['comprova:buildingKey'] = 'b64:AAAA'),
    ],
    ['verdict', (c) => (c['comprova:result']['comprova:verdict'] = 'NOT_FOUND')],
    ['score', (c) => (c['comprova:result']['comprova:score'] = 0.123)],
    ['confidence', (c) => (c['comprova:result']['comprova:confidence'] = 0.123)],
    ['evidence_set_hash', (c) => (c['comprova:evidenceSetHash'] = 'a'.repeat(64))],
    ['policy_hash', (c) => (c['comprova:policy']['comprova:hash'] = 'b'.repeat(64))],
    ['scorer_version', (c) => (c['comprova:algorithm']['comprova:scorerVersion'] = 'tampered')],
    ['timestamp', (c) => (c.validFrom = '2000-01-01T00:00:00.000Z')],
    ['evidence digest', (c) => (c.evidence[0]!['comprova:evidenceSha256'] = 'c'.repeat(64))],
  ]

  it.each(tamperCases)('rejeita adulteração de %s', async (_name, mutate) => {
    const credential = transport(await issue(await newValidation()))
    mutate(credential)
    expect(verifyCredential(credential, { publicKey: keyPair.publicKey }).valid).toBe(false)
  })

  it('permanece verificável após a remoção do material físico (retenção)', async () => {
    const validationId = await newValidation()
    const claimId = await claimIdOf(validationId)

    const sha = Buffer.alloc(32, 5)
    const evidenceId = randomUUID()
    await adminPool.db.insert(t.evidence).values({
      evidenceId,
      kind: 'vlm_output',
      provider: 'test',
      s3Uri: `s3://test/${evidenceId}`,
      sha256: sha,
      capturedAt: null,
      retentionUntil: new Date(Date.now() + 86_400_000),
    })
    await adminPool.db.insert(t.claimEvidence).values({
      claimEvidenceId: randomUUID(),
      tenantId,
      claimId,
      signalId: null,
      evidenceId,
      evidenceSha256: sha,
      checker: 'vlm_visual',
      checkerVersion: '1',
      stance: 'supports',
      strength: 0.7,
      confidence: 0.6,
      source: 'vlm',
      observedAt: new Date(),
      ttlSeconds: 3600,
      expiresAt: new Date(Date.now() + 3_600_000),
      detail: { model: 'test' },
    })

    // Re-sela o evidence_set_hash do conjunto agora que há uma observação material.
    const observations = await observationsOf(claimId)
    await adminPool.db
      .update(t.validation)
      .set({ evidenceSetHash: evidenceSetHashOfObservations(observations) })
      .where(eq(t.validation.validationId, validationId))

    const credential = transport(await issue(validationId))
    expect(credential.evidence.some((o) => o['comprova:evidenceSha256'] === sha.toString('hex'))).toBe(true)
    expect(verifyCredential(credential, { publicKey: keyPair.publicKey }).valid).toBe(true)

    // Retenção: desvincula e apaga o material físico (evidence_sha256 é preservado).
    await adminPool.db
      .update(t.claimEvidence)
      .set({ evidenceId: null })
      .where(eq(t.claimEvidence.claimId, claimId))
    await adminPool.db.delete(t.evidence).where(eq(t.evidence.evidenceId, evidenceId))

    // A credencial já emitida continua válida: depende do binding, não do S3.
    expect(verifyCredential(credential, { publicKey: keyPair.publicKey }).valid).toBe(true)
  })
})

describe('elegibilidade (não emitir credencial parcial)', () => {
  it('recusa validation inexistente', async () => {
    await expect(issue(randomUUID())).rejects.toMatchObject({ failure: 'VALIDATION_NOT_FOUND' })
  })

  it('recusa validation de outro tenant', async () => {
    const otherTenant = await createTenant(adminPool.db, { name: 'credential-other' })
    const otherSubject = await createSubject(adminPool.db, otherTenant)
    const otherValidationId = randomUUID()
    await adminPool.db.insert(t.validation).values({
      validationId: otherValidationId,
      tenantId: otherTenant,
      subjectId: otherSubject,
      mode: 'fast',
      status: 'completed',
      verdict: 'CONFIRMED_COMMERCIAL',
      score: 0.9,
      confidence: 0.9,
      policyVersion: POLICY_VERSION,
      policyHash: policyHashOf(policyYaml),
      scorerVersion: SCORER_VERSION,
      evidenceSetHash: 'a'.repeat(64),
      legalBasis: 'FRAUD_PREVENTION',
      expiresAt: new Date(Date.now() + 86_400_000),
    })

    await expect(issue(otherValidationId)).rejects.toBeInstanceOf(CredentialIssuanceError)
    await expect(issue(otherValidationId)).rejects.toMatchObject({ failure: 'VALIDATION_NOT_FOUND' })
  })

  it('recusa issuer que não pertence ao tenant da validation', async () => {
    const validationId = await newValidation()
    await expect(
      issueCredential(appPool.db, tenantId, validationId, {
        issuer: localIssuer(randomUUID(), 'key-1'),
        signer,
      }),
    ).rejects.toMatchObject({ failure: 'ISSUER_MISMATCH' })
  })

  it('recusa validation não final (partial) — terminalidade exige status=completed', async () => {
    const subjectId = await createSubject(adminPool.db, tenantId)
    const validationId = randomUUID()
    await adminPool.db.insert(t.validation).values({
      validationId,
      tenantId,
      subjectId,
      mode: 'auto',
      status: 'partial',
      verdict: 'INSUFFICIENT_EVIDENCE',
      score: 0,
      confidence: 0.3,
      policyVersion: POLICY_VERSION,
      legalBasis: 'FRAUD_PREVENTION',
      expiresAt: new Date(Date.now() + 86_400_000),
    })

    await expect(issue(validationId)).rejects.toMatchObject({ failure: 'VALIDATION_NOT_FINAL' })
  })

  it('recusa validation sem claim', async () => {
    const subjectId = await createSubject(adminPool.db, tenantId)
    const validationId = randomUUID()
    await adminPool.db.insert(t.validation).values({
      validationId,
      tenantId,
      subjectId,
      mode: 'fast',
      status: 'completed',
      verdict: 'CONFIRMED_COMMERCIAL',
      score: 0.9,
      confidence: 0.9,
      policyVersion: POLICY_VERSION,
      policyHash: policyHashOf(policyYaml),
      scorerVersion: SCORER_VERSION,
      evidenceSetHash: 'a'.repeat(64),
      legalBasis: 'FRAUD_PREVENTION',
      expiresAt: new Date(Date.now() + 86_400_000),
    })

    await expect(issue(validationId)).rejects.toMatchObject({ failure: 'CLAIM_MISSING' })
  })
})
