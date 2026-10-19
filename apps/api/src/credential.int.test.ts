import { createLogger, createMetrics } from '@comprova/observability'
import { createDbPool, eq, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import { evidenceSetHashOfObservations, policyHashOf, SCORER_VERSION } from '@comprova/core'
import {
  decodeEd25519PublicKeyMultibase,
  issuerIdOf,
  issuerScopeOf,
  localIssuer,
  makeHttpIssuerResolver,
  verificationMethodOf,
  verifyCredential,
  verifyCredentialFromIssuer,
  type SecuredVerifiableCredential,
} from '@comprova/credential'
import {
  createApiKey,
  createIssuerSigningKey,
  createSubject,
  createTenant,
  createTestCredentialSigningKey,
  seedGoldenDataset,
  signingKeysConfig,
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
import { buildApp, buildFastPathDeps } from './app.js'
import type { AppConfig } from './config.js'
import { CredentialIssuanceError, issueCredential } from './services/credential-issuer.js'
import { runFastPath } from './services/fastpath.js'
import { makeSigningKeyResolver } from './services/signing-keys.js'

// FASE 12 — ponta a ponta: validation persistida → credential builder → credencial
// assinada → JSON transportável → verifier independente → VALID. Também cobre a
// independência do material físico (retenção) e a recusa de emissão parcial.

const PEPPER = 'test-pepper-credential'
const POLICY_VERSION = '2026.13.1'
const ISSUER_ORIGIN = 'https://issuer.test'
const KEY_ID = 'key-1'

// Chave de assinatura efêmera do teste: a privada entra em
// `CREDENTIAL_SIGNING_KEYS` (PKCS#8 PEM) e a pública é registrada em
// `issuer_signing_key` (material público). Nenhuma chave literal no repositório.
const signing = createTestCredentialSigningKey(KEY_ID)
// Tenant B: MESMO `key_id`, chave própria — prova que o namespace é o issuer.
const otherSigning = createTestCredentialSigningKey(KEY_ID)
// Tenant C: a chave PUBLICADA não corresponde ao material privado configurado —
// prova o guard de coerência (SIGNING_KEY_MISMATCH).
const mismatchSigning = createTestCredentialSigningKey(KEY_ID)

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
await createIssuerSigningKey(adminPool.db, tenantId, signing)

// Tenant B: issuer próprio, chave própria (mesmo `key_id`).
const otherTenantId = await createTenant(adminPool.db, { name: 'credential-tenant-b' })
const otherKey = await createApiKey(adminPool.db, otherTenantId, PEPPER, {
  scopes: ['validate:read', 'validate:write'],
})
await createIssuerSigningKey(adminPool.db, otherTenantId, otherSigning)

// Tenant C: publica a chave de A, mas tem material privado diferente em config.
const mismatchTenantId = await createTenant(adminPool.db, { name: 'credential-tenant-mismatch' })
const mismatchKey = await createApiKey(adminPool.db, mismatchTenantId, PEPPER, {
  scopes: ['validate:read', 'validate:write'],
})
await createIssuerSigningKey(adminPool.db, mismatchTenantId, signing)

const appPool = createDbPool(db.appUrl)
const config: AppConfig = {
  DATABASE_URL: db.appUrl,
  REDIS_URL: testRedis.url,
  API_KEY_PEPPER: PEPPER,
  CREDENTIAL_ISSUER_ORIGIN: 'https://issuer.test',
  CREDENTIAL_SIGNING_KEYS: signingKeysConfig([
    { tenantId, key: signing },
    { tenantId: otherTenantId, key: otherSigning },
    { tenantId: mismatchTenantId, key: mismatchSigning },
  ]),
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

const postCnpj = (apiKey = key.plaintext) =>
  app.inject({
    method: 'POST',
    url: '/v1/validations',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
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

const issuer = localIssuer(ISSUER_ORIGIN, tenantId, KEY_ID)
const signingKeys = makeSigningKeyResolver(config.CREDENTIAL_SIGNING_KEYS)
/** Método confiável declarado pelo consumidor (identidade + chave). */
const trusted = { id: verificationMethodOf(issuer), publicKey: signing.publicKey }

const issue = (validationId: string, now?: () => Date): Promise<SecuredVerifiableCredential> =>
  issueCredential(appPool.db, tenantId, validationId, {
    issuerOrigin: ISSUER_ORIGIN,
    signingKeys,
    now,
  })

const transport = (credential: SecuredVerifiableCredential): SecuredVerifiableCredential =>
  JSON.parse(JSON.stringify(credential)) as SecuredVerifiableCredential

const newValidationAs = async (apiKey: string): Promise<string> => {
  const res = await postCnpj(apiKey)
  expect(res.statusCode).toBe(200)
  return res.json().validation_id as string
}

const newValidation = (): Promise<string> => newValidationAs(key.plaintext)

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
    expect(credential.issuer).toBe(issuerIdOf(ISSUER_ORIGIN, tenantId))
    expect(credential.issuer).toBe(issuer.id)
    expect(credential.issuer).toMatch(/^https:\/\/issuer\.test\/issuers\/[A-Za-z0-9_-]{43}$/)
    expect(credential.issuer).not.toContain(tenantId)
    expect(credential.credentialSubject['comprova:docType']).toBe('CNPJ')
    expect(credential.credentialSubject.id).toMatch(
      /^https:\/\/issuer\.test\/issuers\/[A-Za-z0-9_-]{43}\/subjects\/[0-9a-f]{64}$/,
    )
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
    // O fluxo rápido persiste o instante da CONCLUSÃO da análise; `validFrom` é
    // esse instante (nunca o início da requisição).
    expect(row!.completedAt).not.toBeNull()
    expect(row!.completedAt!.getTime()).toBeGreaterThanOrEqual(row!.createdAt!.getTime())
    expect(credential['comprova:result']['comprova:completedAt']).toBe(row!.completedAt!.toISOString())
    expect(credential.validFrom).toBe(row!.completedAt!.toISOString())
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

    // O verifier só recebe a credencial (JSON), a chave pública confiável e o id
    // do método ao qual essa chave pertence.
    expect(
      verifyCredential(credential, {
        trusted,
        expectedIssuerId: issuer.id,
      }),
    ).toEqual({ valid: true })
  })

  const tamperCases: ReadonlyArray<readonly [string, (credential: SecuredVerifiableCredential) => void]> = [
    ['issuer', (c) => (c.issuer = `${ISSUER_ORIGIN}/issuers/${randomUUID()}`)],
    ['subject', (c) => (c.credentialSubject.id = `${issuer.id}/subjects/${'f'.repeat(64)}`)],
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
    expect(verifyCredential(credential, { trusted }).valid).toBe(false)
  })

  it('marca a prova com o instante real da emissão, não com a janela da validation', async () => {
    const validationId = await newValidation()
    const row = await validationRow(validationId)
    const issuedAt = new Date('2026-03-01T00:00:00.000Z')

    const credential = transport(await issue(validationId, () => issuedAt))

    expect(credential.proof.created).toBe(issuedAt.toISOString())
    expect(credential.proof.created).not.toBe(credential.validFrom)
    expect(credential.proof.created).not.toBe(row!.createdAt!.toISOString())
    expect(credential.proof.created).not.toBe(credential['comprova:result']['comprova:completedAt'])
    // Adulterar o instante de assinatura invalida o proof: ele está assinado.
    const tampered = transport(credential)
    tampered.proof.created = new Date(0).toISOString()
    expect(verifyCredential(tampered, { trusted }).valid).toBe(false)
  })

  it('não antecipa `validFrom`: registra o instante da CONCLUSÃO da análise, não o início da requisição', async () => {
    // Relógio que avança a cada leitura: a primeira é o início de `runFastPath`
    // (`created_at`); as seguintes vêm depois da Receita, do enriquecimento do
    // endereço e dos checkers (`completed_at`). Sem relógio próprio, uma análise
    // demorada receberia `validFrom` anterior ao veredito.
    const startedAt = new Date('2026-05-01T00:00:00.000Z')
    const finishedAt = new Date('2026-05-01T00:03:30.000Z')
    let reads = 0
    const slowClock = { now: (): Date => (reads++ === 0 ? startedAt : finishedAt) }
    const fastPath = { ...buildFastPathDeps(appPool.db, config), clock: slowClock }

    const result = await runFastPath(
      fastPath,
      { tenantId, apiKeyId: null, issuerScopes: null },
      {
        documentType: 'CNPJ',
        documentValue: '12345678000195',
        addressInput: null,
        legalBasis: 'FRAUD_PREVENTION',
        mode: 'fast',
        idempotencyKey: null,
      },
    )

    const row = await validationRow(result.validationId)
    expect(row!.createdAt!.toISOString()).toBe(startedAt.toISOString())
    expect(row!.completedAt!.toISOString()).toBe(finishedAt.toISOString())
    expect(row!.completedAt!.getTime()).toBeGreaterThan(row!.createdAt!.getTime())

    const credential = transport(await issue(result.validationId))
    expect(credential.validFrom).toBe(finishedAt.toISOString())
    expect(credential['comprova:result']['comprova:completedAt']).toBe(finishedAt.toISOString())
    // `validFrom` NÃO antecede a conclusão real da análise.
    expect(Date.parse(credential.validFrom)).toBeGreaterThan(row!.createdAt!.getTime())
    expect(verifyCredential(credential, { trusted, expectedIssuerId: issuer.id })).toEqual({ valid: true })
  })

  it('deriva o issuer do tenant escopado e da origem configurada (não existe issuer avulso)', async () => {
    const credential = await issue(await newValidation())

    expect(credential.issuer).toBe(issuerIdOf(ISSUER_ORIGIN, tenantId))
    expect(credential.issuer).not.toBe(issuerIdOf(ISSUER_ORIGIN, randomUUID()))
    expect(credential.proof.verificationMethod).toBe(`${credential.issuer}#${KEY_ID}`)
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
    expect(verifyCredential(credential, { trusted }).valid).toBe(true)

    // Retenção: desvincula e apaga o material físico (evidence_sha256 é preservado).
    await adminPool.db
      .update(t.claimEvidence)
      .set({ evidenceId: null })
      .where(eq(t.claimEvidence.claimId, claimId))
    await adminPool.db.delete(t.evidence).where(eq(t.evidence.evidenceId, evidenceId))

    // A credencial já emitida continua válida: depende do binding, não do S3.
    expect(verifyCredential(credential, { trusted }).valid).toBe(true)
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

  it('não existe caminho para atribuir a assertion a outro issuer', async () => {
    // O issuer deixou de ser parâmetro: ele é derivado da origem configurada +
    // tenant escopado pela leitura (RLS). O tenant é o único eixo de atribuição.
    const validationId = await newValidation()
    const credential = await issueCredential(appPool.db, tenantId, validationId, {
      issuerOrigin: ISSUER_ORIGIN,
      signingKeys,
    })

    expect(credential.issuer).toBe(issuerIdOf(ISSUER_ORIGIN, tenantId))
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

  it('recusa validação concluída sem instante de conclusão (registro antigo) — não presume `created_at`', async () => {
    // Política explícita para dados anteriores: sem `completed_at` a conclusão
    // real é desconhecida, e `created_at` (início da requisição) não é aceito
    // como substituto.
    const validationId = await newValidation()
    await adminPool.db
      .update(t.validation)
      .set({ completedAt: null })
      .where(eq(t.validation.validationId, validationId))

    await expect(issue(validationId)).rejects.toMatchObject({ failure: 'COMPLETION_TIME_MISSING' })
  })

  it('protege a janela de validade: `completed_at < expires_at` emite; igual ou posterior recusa (sem estender o prazo)', async () => {
    const setCompletion = (validationId: string, completedAt: Date) =>
      adminPool.db
        .update(t.validation)
        .set({ completedAt })
        .where(eq(t.validation.validationId, validationId))

    // Conclusão 1 ms antes do horizonte: janela mínima, mas válida e verificável.
    const atEdge = await newValidation()
    const edgeRow = await validationRow(atEdge)
    const lastInstant = new Date(edgeRow!.expiresAt!.getTime() - 1)
    await setCompletion(atEdge, lastInstant)

    const credential = transport(await issue(atEdge))
    expect(credential.validFrom).toBe(lastInstant.toISOString())
    expect(credential.validUntil).toBe(edgeRow!.expiresAt!.toISOString())
    expect(Date.parse(credential.validFrom)).toBeLessThan(Date.parse(credential.validUntil!))
    expect(verifyCredential(credential, { trusted, expectedIssuerId: issuer.id })).toEqual({ valid: true })

    // `completed_at == expires_at` (janela vazia) e `completed_at > expires_at`
    // (janela invertida): recusa explícita — e `expires_at` (horizonte de
    // retenção, política de 30 dias) NÃO é recalculado nem estendido.
    for (const [label, delta] of [
      ['igual', 0],
      ['posterior', 1],
    ] as const) {
      const validationId = await newValidation()
      const row = await validationRow(validationId)
      await setCompletion(validationId, new Date(row!.expiresAt!.getTime() + delta))

      await expect(issue(validationId), label).rejects.toMatchObject({
        failure: 'VALIDITY_WINDOW_INVALID',
      })

      const after = await validationRow(validationId)
      expect(after!.completedAt!.getTime(), label).toBeGreaterThanOrEqual(after!.expiresAt!.getTime())
      expect(after!.expiresAt!.getTime(), label).toBe(row!.expiresAt!.getTime())
    }
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
      // Concluída e com instante de conclusão: o que falta aqui é só o claim.
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      completedAt: new Date('2026-01-01T00:00:02.000Z'),
      expiresAt: new Date(Date.now() + 86_400_000),
    })

    await expect(issue(validationId)).rejects.toMatchObject({ failure: 'CLAIM_MISSING' })
  })
})

// FASE 13 — porta HTTP de emissão + publicação do material público + verificação
// com resolução de chave. O verificador só recebe a credencial e o resolver; o
// resolver só fala HTTP com a origem confiável do issuer.
describe('emissão HTTP e verificação com resolução de chave pública', () => {
  const PRIVATE_KEY_MARKER = 'PRIVATE KEY'

  /** `fetch` que atravessa o roteador do Fastify (HTTP de verdade, sem rede). */
  const appFetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const res = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` })
    return new Response(res.body, {
      status: res.statusCode,
      headers: { 'content-type': String(res.headers['content-type'] ?? 'application/json') },
    })
  }) as typeof fetch

  const resolver = makeHttpIssuerResolver({
    trustedIssuerOrigins: [ISSUER_ORIGIN],
    fetch: appFetch,
  })

  const postCredential = (validationId: string, apiKey = key.plaintext) =>
    app.inject({
      method: 'POST',
      url: `/v1/validations/${validationId}/credential`,
      headers: { authorization: `Bearer ${apiKey}` },
    })

  it('POST /v1/validations/:id/credential devolve a VC e o verificador independente valida', async () => {
    const validationId = await newValidation()

    const res = await postCredential(validationId)
    expect(res.statusCode).toBe(200)

    const credential = res.json() as SecuredVerifiableCredential
    expect(credential.issuer).toBe(issuer.id)
    expect(credential.issuer).toBe(issuerIdOf(ISSUER_ORIGIN, tenantId))
    expect(credential.proof.verificationMethod).toBe(verificationMethodOf(issuer))

    // O verificador NÃO acessa o banco: recebe só a credencial + o resolver.
    const result = await verifyCredentialFromIssuer(credential, resolver, {
      expectedIssuerId: issuer.id,
    })
    expect(result).toEqual({ valid: true })
  })

  it('publica apenas material público em GET /issuers/:scope', async () => {
    const credential = (await postCredential(await newValidation())).json() as SecuredVerifiableCredential

    const res = await app.inject({ method: 'GET', url: `/issuers/${issuerScopeOf(tenantId)}` })
    expect(res.statusCode).toBe(200)
    const document = res.json() as {
      id: string
      verificationMethod: Array<Record<string, string>>
    }

    expect(document.id).toBe(credential.issuer)
    expect(document.verificationMethod).toEqual([
      {
        id: credential.proof.verificationMethod,
        type: 'Multikey',
        controller: credential.issuer,
        publicKeyMultibase: expect.stringMatching(/^z[1-9A-HJ-NP-Za-km-z]+$/),
      },
    ])
    expect(
      decodeEd25519PublicKeyMultibase(document.verificationMethod[0]!.publicKeyMultibase!).equals(
        signing.publicKey,
      ),
    ).toBe(true)

    // Nenhum material privado nem identificador interno no documento público.
    const json = JSON.stringify(document)
    expect(json).not.toContain(PRIVATE_KEY_MARKER)
    expect(json).not.toContain(signing.privateKeyPkcs8Pem)
    expect(json).not.toContain(tenantId)
    expect(json).not.toContain('doc_hmac')
  })

  it('recusa emissão sem autenticação', async () => {
    const validationId = await newValidation()
    const res = await app.inject({
      method: 'POST',
      url: `/v1/validations/${validationId}/credential`,
    })
    expect(res.statusCode).toBe(401)
  })

  it('isola tenants: a credencial de um tenant não é emitida por outro', async () => {
    const validationId = await newValidation()
    const otherTenant = await createTenant(adminPool.db, { name: 'credential-http-other' })
    const otherKey = await createApiKey(adminPool.db, otherTenant, PEPPER)

    const res = await postCredential(validationId, otherKey.plaintext)
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('NOT_FOUND')
  })

  it('recusa validation não final com problem+json estável (409)', async () => {
    const validationId = await newValidation()
    await adminPool.db
      .update(t.validation)
      .set({ status: 'partial' })
      .where(eq(t.validation.validationId, validationId))

    const res = await postCredential(validationId)
    expect(res.statusCode).toBe(409)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.json().code).toBe('CREDENTIAL_NOT_ISSUABLE')
    expect(res.json().detail).toBe('VALIDATION_NOT_FINAL')
  })

  it('recusa validation fora da janela de validade (409), sem estender o prazo', async () => {
    const validationId = await newValidation()
    const row = await validationRow(validationId)
    await adminPool.db
      .update(t.validation)
      .set({ completedAt: row!.expiresAt })
      .where(eq(t.validation.validationId, validationId))

    const res = await postCredential(validationId)
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('CREDENTIAL_NOT_ISSUABLE')
    expect(res.json().detail).toBe('VALIDITY_WINDOW_INVALID')

    const after = await validationRow(validationId)
    expect(after!.expiresAt!.getTime()).toBe(row!.expiresAt!.getTime())
  })

  it('a credencial transportada por HTTP é autocontida (nenhuma chave privada)', async () => {
    const credential = await postCredential(await newValidation())
    const json = credential.body
    expect(json).not.toContain(PRIVATE_KEY_MARKER)
    expect(json).not.toContain(signing.privateKeyPkcs8Pem)
    expect(await verifyCredentialFromIssuer(JSON.parse(json), resolver)).toEqual({ valid: true })
  })
})

// FASE 14 — identidade criptográfica por tenant: cada tenant assina com a SUA
// chave, o issuer (não o `key_id`) é o namespace, e a chave pública é resolvida
// pelo `issuer.id` publicado.
describe('chave de assinatura escopada por tenant', () => {
  /** `fetch` que atravessa o roteador do Fastify (HTTP real, sem rede). */
  const appFetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const res = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` })
    return new Response(res.body, {
      status: res.statusCode,
      headers: { 'content-type': String(res.headers['content-type'] ?? 'application/json') },
    })
  }) as typeof fetch

  const credentialOf = async (apiKey: string): Promise<SecuredVerifiableCredential> => {
    const validationId = await newValidationAs(apiKey)
    const res = await app.inject({
      method: 'POST',
      url: `/v1/validations/${validationId}/credential`,
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(res.statusCode).toBe(200)
    return res.json() as SecuredVerifiableCredential
  }

  it('duas tenants emitem com chaves diferentes (mesmo key_id) e a chave de uma não valida a credencial da outra', async () => {
    const credentialA = await credentialOf(key.plaintext)
    const credentialB = await credentialOf(otherKey.plaintext)

    // Issuers distintos com o MESMO `key_id` ('key-1'): o namespace é o issuer.
    expect(credentialA.issuer).toBe(issuerIdOf(ISSUER_ORIGIN, tenantId))
    expect(credentialB.issuer).toBe(issuerIdOf(ISSUER_ORIGIN, otherTenantId))
    expect(credentialA.issuer).not.toBe(credentialB.issuer)
    expect(credentialA.proof.verificationMethod).toBe(`${credentialA.issuer}#${KEY_ID}`)
    expect(credentialB.proof.verificationMethod).toBe(`${credentialB.issuer}#${KEY_ID}`)

    // Cada credencial valida com a SUA chave pública...
    expect(
      verifyCredential(credentialA, {
        trusted: { id: credentialA.proof.verificationMethod, publicKey: signing.publicKey },
        expectedIssuerId: credentialA.issuer,
      }),
    ).toEqual({ valid: true })
    expect(
      verifyCredential(credentialB, {
        trusted: { id: credentialB.proof.verificationMethod, publicKey: otherSigning.publicKey },
        expectedIssuerId: credentialB.issuer,
      }),
    ).toEqual({ valid: true })

    // ...e NÃO com a chave pública da outra (assinatura inválida).
    expect(
      verifyCredential(credentialA, {
        trusted: { id: credentialA.proof.verificationMethod, publicKey: otherSigning.publicKey },
        expectedIssuerId: credentialA.issuer,
      }),
    ).toEqual({ valid: false, reason: 'INVALID_SIGNATURE' })
    expect(
      verifyCredential(credentialB, {
        trusted: { id: credentialB.proof.verificationMethod, publicKey: signing.publicKey },
        expectedIssuerId: credentialB.issuer,
      }),
    ).toEqual({ valid: false, reason: 'INVALID_SIGNATURE' })
  })

  it('o verificador remoto resolve a chave pelo issuer e recusa a chave do outro', async () => {
    const resolver = makeHttpIssuerResolver({ trustedIssuerOrigins: [ISSUER_ORIGIN], fetch: appFetch })
    const credentialA = await credentialOf(key.plaintext)
    const credentialB = await credentialOf(otherKey.plaintext)

    expect(
      await verifyCredentialFromIssuer(credentialA, resolver, { expectedIssuerId: credentialA.issuer }),
    ).toEqual({ valid: true })
    expect(
      await verifyCredentialFromIssuer(credentialB, resolver, { expectedIssuerId: credentialB.issuer }),
    ).toEqual({ valid: true })

    // Trocar o verificationMethod para o issuer do outro (mantendo a assinatura)
    // é recusado ANTES de resolver: o método não pertence ao issuer declarado.
    const tampered = transport(credentialA)
    tampered.proof.verificationMethod = credentialB.proof.verificationMethod
    expect(await verifyCredentialFromIssuer(tampered, resolver)).toEqual({
      valid: false,
      reason: 'VERIFICATION_METHOD_MISMATCH',
    })
  })

  it('GET /issuers/:scope publica só a chave do issuer pedido (e 404 para escopo sem chave)', async () => {
    const documentOf = async (tenant: string) => {
      const res = await app.inject({ method: 'GET', url: `/issuers/${issuerScopeOf(tenant)}` })
      expect(res.statusCode).toBe(200)
      return res.json() as {
        id: string
        verificationMethod: Array<{ id: string; publicKeyMultibase: string }>
      }
    }

    const docA = await documentOf(tenantId)
    const docB = await documentOf(otherTenantId)

    expect(docA.id).toBe(issuerIdOf(ISSUER_ORIGIN, tenantId))
    expect(docB.id).toBe(issuerIdOf(ISSUER_ORIGIN, otherTenantId))
    expect(docA.verificationMethod).toHaveLength(1)
    expect(docB.verificationMethod).toHaveLength(1)
    expect(
      decodeEd25519PublicKeyMultibase(docA.verificationMethod[0]!.publicKeyMultibase).equals(
        signing.publicKey,
      ),
    ).toBe(true)
    expect(
      decodeEd25519PublicKeyMultibase(docB.verificationMethod[0]!.publicKeyMultibase).equals(
        otherSigning.publicKey,
      ),
    ).toBe(true)
    // O documento de A não contém a chave (nem o escopo) do issuer B.
    expect(JSON.stringify(docA)).not.toContain(issuerScopeOf(otherTenantId))

    const missing = await app.inject({ method: 'GET', url: `/issuers/${'a'.repeat(43)}` })
    expect(missing.statusCode).toBe(404)
  })

  it('tenant sem chave registrada não emite (409), sem cair em chave global', async () => {
    const bareTenant = await createTenant(adminPool.db, { name: 'credential-no-key' })
    const bareKey = await createApiKey(adminPool.db, bareTenant, PEPPER, {
      scopes: ['validate:read', 'validate:write'],
    })
    const validationId = await newValidationAs(bareKey.plaintext)

    const res = await app.inject({
      method: 'POST',
      url: `/v1/validations/${validationId}/credential`,
      headers: { authorization: `Bearer ${bareKey.plaintext}` },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('CREDENTIAL_NOT_ISSUABLE')
    expect(res.json().detail).toBe('SIGNING_KEY_UNAVAILABLE')
  })

  it('material privado incompatível com a chave publicada não emite (409 SIGNING_KEY_MISMATCH)', async () => {
    const validationId = await newValidationAs(mismatchKey.plaintext)

    const res = await app.inject({
      method: 'POST',
      url: `/v1/validations/${validationId}/credential`,
      headers: { authorization: `Bearer ${mismatchKey.plaintext}` },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('CREDENTIAL_NOT_ISSUABLE')
    expect(res.json().detail).toBe('SIGNING_KEY_MISMATCH')
  })
})
