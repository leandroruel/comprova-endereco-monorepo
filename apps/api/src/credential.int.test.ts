import { createLogger, createMetrics } from '@comprova/observability'
import { and, createDbPool, eq, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import { evidenceSetHashOfObservations, policyHashOf, SCORER_VERSION } from '@comprova/core'
import {
  DID_CONTEXT_URL,
  decodeEd25519PublicKeyMultibase,
  didDocumentUrlOf,
  didOfIssuer,
  didVerificationMethodOf,
  encodeEd25519PublicKeyMultibase,
  issuerIdOf,
  issuerScopeOf,
  localIssuer,
  makeHttpCredentialStatusResolver,
  makeHttpDidResolver,
  makeHttpIssuerResolver,
  verificationMethodOf,
  verifyCredentialIntegrity,
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

// Tenant D: chave SUPERADA (`active = false`) mas com material privado
// configurado — prova que é a seleção da chave ativa que barra a emissão, e não
// a ausência de configuração.
const supersededTenantId = await createTenant(adminPool.db, { name: 'credential-superseded' })
const supersededKey = await createApiKey(adminPool.db, supersededTenantId, PEPPER, {
  scopes: ['validate:read', 'validate:write'],
})
const supersededSigning = createTestCredentialSigningKey(KEY_ID)
await createIssuerSigningKey(adminPool.db, supersededTenantId, supersededSigning, { active: false })

// Tenant E: revogação da chave ativa (ADR-0029). Isolado dos demais porque a
// revogação é irreversível: o tenant fica sem chave confiável depois do teste.
const lifecycleTenantId = await createTenant(adminPool.db, { name: 'credential-lifecycle' })
const lifecycleKey = await createApiKey(adminPool.db, lifecycleTenantId, PEPPER, {
  scopes: ['validate:read', 'validate:write', 'keys:write'],
})
const lifecycleSigning = createTestCredentialSigningKey('lifecycle-key')
await createIssuerSigningKey(adminPool.db, lifecycleTenantId, lifecycleSigning)

// Tenant F: expiração AGENDADA (revoked_at no futuro). A chave continua
// publicada/ativa até o instante — não é o mesmo que `active = false`.
const scheduledTenantId = await createTenant(adminPool.db, { name: 'credential-scheduled-key' })
const scheduledKey = await createApiKey(adminPool.db, scheduledTenantId, PEPPER, {
  scopes: ['validate:read', 'validate:write', 'keys:write'],
})
const scheduledSigning = createTestCredentialSigningKey('scheduled-key')
await createIssuerSigningKey(adminPool.db, scheduledTenantId, scheduledSigning)

// Tenant G: rotação (`active = false`) SEM revogação. A chave antiga continua
// publicada; a nova é que assina. Revogar a antiga depois a remove.
const rotationTenantId = await createTenant(adminPool.db, { name: 'credential-rotation' })
const rotationKey = await createApiKey(adminPool.db, rotationTenantId, PEPPER, {
  scopes: ['validate:read', 'validate:write', 'keys:write'],
})
const rotationOldSigning = createTestCredentialSigningKey('key-old')
const rotationNewSigning = createTestCredentialSigningKey('key-new')
await createIssuerSigningKey(adminPool.db, rotationTenantId, rotationOldSigning)
await createIssuerSigningKey(adminPool.db, rotationTenantId, rotationNewSigning, { active: false })

// Tenant H: API key SOMENTE-LEITURA. Revogar é uma operação administrativa;
// a rota exige `keys:write` e deve recusar mesmo com uma API key válida (403),
// sem revelar se o key_id existe.
const readOnlyTenantId = await createTenant(adminPool.db, { name: 'credential-readonly-key' })
const readOnlyKey = await createApiKey(adminPool.db, readOnlyTenantId, PEPPER, {
  scopes: ['validate:read'],
})
const readOnlySigning = createTestCredentialSigningKey('readonly-key')
await createIssuerSigningKey(adminPool.db, readOnlyTenantId, readOnlySigning)

// Tenant I: API key com autoridade de validação E administração. O snapshot de
// auditoria (`validation.issuer_scopes`) guarda `keys:write`; a credencial não
// o publica, porque ele não é uma capacidade do titular nem da credencial.
const combinedTenantId = await createTenant(adminPool.db, { name: 'credential-combined-scopes' })
const combinedKey = await createApiKey(adminPool.db, combinedTenantId, PEPPER, {
  scopes: ['validate:read', 'validate:write', 'keys:write'],
})
const combinedSigning = createTestCredentialSigningKey('combined-key')
await createIssuerSigningKey(adminPool.db, combinedTenantId, combinedSigning)

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
    { tenantId: supersededTenantId, key: supersededSigning },
    { tenantId: lifecycleTenantId, key: lifecycleSigning },
    { tenantId: scheduledTenantId, key: scheduledSigning },
    { tenantId: rotationTenantId, key: rotationOldSigning },
    { tenantId: rotationTenantId, key: rotationNewSigning },
    { tenantId: readOnlyTenantId, key: readOnlySigning },
    { tenantId: combinedTenantId, key: combinedSigning },
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
      ttlSeconds: t.claimEvidence.ttlSeconds,
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
    expect(credential.assertionAuthority).toEqual({
      scopes: ['validate:read', 'validate:write'],
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
      verifyCredentialIntegrity(credential, {
        trusted,
        expectedIssuerId: issuer.id,
      }),
    ).toMatchObject({ valid: true })
  })

  it('mantém keys:write no snapshot de auditoria, mas não o publica na credencial', async () => {
    const validationId = await newValidationAs(combinedKey.plaintext)
    const row = await validationRow(validationId)

    // Auditoria: o snapshot persistido continua sendo a autoridade EFETIVA
    // completa da API key no momento da emissão.
    expect(row?.issuerScopes).toEqual(['validate:read', 'validate:write', 'keys:write'])

    const res = await app.inject({
      method: 'POST',
      url: `/v1/validations/${validationId}/credential`,
      headers: { authorization: `Bearer ${combinedKey.plaintext}` },
    })
    expect(res.statusCode).toBe(200)
    const credential = res.json() as SecuredVerifiableCredential

    // A credencial só declara a autoridade de validação do issuer. `keys:write`
    // não é uma permissão do titular e não aparece no documento assinado.
    expect(credential.assertionAuthority).toEqual({
      scopes: ['validate:read', 'validate:write'],
    })
    expect(JSON.stringify(credential)).not.toContain('keys:write')
    expect(credential.credentialSubject).not.toHaveProperty('assertionAuthority')

    // Remover o scope administrativo do documento não quebra a assinatura nem a
    // verificação independente.
    const combinedIssuer = localIssuer(ISSUER_ORIGIN, combinedTenantId, 'combined-key')
    expect(
      verifyCredentialIntegrity(credential, {
        trusted: {
          id: verificationMethodOf(combinedIssuer),
          publicKey: combinedSigning.publicKey,
        },
        expectedIssuerId: combinedIssuer.id,
      }),
    ).toMatchObject({ valid: true })
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
    expect(verifyCredentialIntegrity(credential, { trusted }).valid).toBe(false)
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
    expect(verifyCredentialIntegrity(tampered, { trusted }).valid).toBe(false)
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
    expect(verifyCredentialIntegrity(credential, { trusted, expectedIssuerId: issuer.id })).toMatchObject({
      valid: true,
    })
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
    expect(verifyCredentialIntegrity(credential, { trusted }).valid).toBe(true)

    // Retenção: desvincula e apaga o material físico (evidence_sha256 é preservado).
    await adminPool.db
      .update(t.claimEvidence)
      .set({ evidenceId: null })
      .where(eq(t.claimEvidence.claimId, claimId))
    await adminPool.db.delete(t.evidence).where(eq(t.evidence.evidenceId, evidenceId))

    // A credencial já emitida continua válida: depende do binding, não do S3.
    expect(verifyCredentialIntegrity(credential, { trusted }).valid).toBe(true)
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

  it('protege a janela da CREDENCIAL: `completed_at < validUntil` emite; igual ou posterior recusa', async () => {
    const setCompletion = (validationId: string, completedAt: Date) =>
      adminPool.db
        .update(t.validation)
        .set({ completedAt })
        .where(eq(t.validation.validationId, validationId))

    const evidenceHorizonOf = async (validationId: string): Promise<Date> => {
      const claimId = await claimIdOf(validationId)
      const observations = await observationsOf(claimId)
      return new Date(Math.min(...observations.map((o) => o.observedAt.getTime() + o.ttlSeconds * 1000)))
    }

    // Conclusão 1 ms antes do horizonte das evidências: a policy (30 dias) não
    // limita; a evidência limita. Janela mínima, mas válida e verificável.
    const atEdge = await newValidation()
    const edgeRow = await validationRow(atEdge)
    const evidenceHorizon = await evidenceHorizonOf(atEdge)
    const lastInstant = new Date(evidenceHorizon.getTime() - 1)
    await setCompletion(atEdge, lastInstant)

    const credential = transport(await issue(atEdge))
    expect(credential.validFrom).toBe(lastInstant.toISOString())
    expect(credential.validUntil).toBe(evidenceHorizon.toISOString())
    expect(credential.validUntil).not.toBe(edgeRow!.expiresAt!.toISOString())
    expect(Date.parse(credential.validFrom)).toBeLessThan(Date.parse(credential.validUntil!))
    expect(verifyCredentialIntegrity(credential, { trusted, expectedIssuerId: issuer.id })).toMatchObject({
      valid: true,
    })

    // `completed_at == validUntil` (janela vazia) e `completed_at > validUntil`
    // (invertida): recusa explícita — e `expires_at` (retenção) não é alterado.
    for (const [label, delta] of [
      ['igual', 0],
      ['posterior', 1],
    ] as const) {
      const validationId = await newValidation()
      const row = await validationRow(validationId)
      const horizon = await evidenceHorizonOf(validationId)
      await setCompletion(validationId, new Date(horizon.getTime() + delta))

      await expect(issue(validationId), label).rejects.toMatchObject({
        failure: 'VALIDITY_WINDOW_INVALID',
      })

      const after = await validationRow(validationId)
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
  const statusResolver = makeHttpCredentialStatusResolver({
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
      statusResolver,
    })
    expect(result).toMatchObject({ valid: true })
  })

  it('reemitir a mesma validation devolve bytes idênticos e mantém um único status', async () => {
    const validationId = await newValidation()
    const firstAt = new Date('2026-03-01T12:00:00.000Z')
    const later = new Date('2026-04-01T12:00:00.000Z')

    const first = await issue(validationId, () => firstAt)
    const second = await issue(validationId, () => later)

    // `proof.created` é o da PRIMEIRA emissão; a assinatura Ed25519/JCS é
    // determinística, então o JSON inteiro é idêntico.
    expect(first.proof.created).toBe(firstAt.toISOString())
    expect(second.proof.created).toBe(firstAt.toISOString())
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))

    const issuance = await adminPool.db
      .select({
        credentialId: t.credentialIssuance.credentialId,
        issuedAt: t.credentialIssuance.issuedAt,
      })
      .from(t.credentialIssuance)
      .where(eq(t.credentialIssuance.validationId, validationId))
    expect(issuance).toHaveLength(1)
    expect(issuance[0]?.issuedAt.toISOString()).toBe(firstAt.toISOString())

    const statuses = await adminPool.db
      .select({ credentialId: t.credentialStatus.credentialId })
      .from(t.credentialStatus)
      .where(eq(t.credentialStatus.credentialId, issuance[0]!.credentialId))
    expect(statuses).toHaveLength(1)
  })

  it('mudança de CREDENTIAL_ISSUER_ORIGIN bloqueia a reemissão com 409 explícito', async () => {
    const validationId = await newValidation()
    // Primeira emissão sob a origem configurada.
    await issue(validationId)

    // A mesma validation reemitida por uma API com OUTRA origem: o
    // `credential_id` derivado do issuer muda, mas a linha da primeira emissão é
    // append-only e presa à validation. Precisa ser um 409 com detalhe, não 500.
    const changedApp = await buildApp({
      config: { ...config, CREDENTIAL_ISSUER_ORIGIN: 'https://issuer.changed.test' },
      db: appPool.db,
      redis,
      logger: createLogger({ level: 'silent' }),
      metrics: createMetrics(),
    })
    try {
      const res = await changedApp.inject({
        method: 'POST',
        url: `/v1/validations/${validationId}/credential`,
        headers: { authorization: `Bearer ${key.plaintext}` },
      })
      expect(res.statusCode).toBe(409)
      expect(res.headers['content-type']).toContain('application/problem+json')
      expect(res.json().code).toBe('CREDENTIAL_NOT_ISSUABLE')
      expect(res.json().detail).toBe('ISSUANCE_IDENTITY_CONFLICT')
    } finally {
      await changedApp.close()
    }
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

  it('recusa validation fora da janela de validade da credencial (409), sem estender o prazo', async () => {
    const validationId = await newValidation()
    const row = await validationRow(validationId)
    // `validUntil` é limitado pelo TTL das evidências; uma conclusão no futuro
    // distante não pode ser "cabida" esticando a retenção.
    await adminPool.db
      .update(t.validation)
      .set({ completedAt: new Date('2100-01-01T00:00:00.000Z') })
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
    expect(await verifyCredentialFromIssuer(JSON.parse(json), resolver, { statusResolver })).toEqual({
      valid: true,
    })
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

  const statusResolver = makeHttpCredentialStatusResolver({
    trustedIssuerOrigins: [ISSUER_ORIGIN],
    fetch: appFetch,
  })

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
      verifyCredentialIntegrity(credentialA, {
        trusted: { id: credentialA.proof.verificationMethod, publicKey: signing.publicKey },
        expectedIssuerId: credentialA.issuer,
      }),
    ).toMatchObject({ valid: true })
    expect(
      verifyCredentialIntegrity(credentialB, {
        trusted: { id: credentialB.proof.verificationMethod, publicKey: otherSigning.publicKey },
        expectedIssuerId: credentialB.issuer,
      }),
    ).toMatchObject({ valid: true })

    // ...e NÃO com a chave pública da outra (assinatura inválida).
    expect(
      verifyCredentialIntegrity(credentialA, {
        trusted: { id: credentialA.proof.verificationMethod, publicKey: otherSigning.publicKey },
        expectedIssuerId: credentialA.issuer,
      }),
    ).toMatchObject({ valid: false, reason: 'INVALID_SIGNATURE' })
    expect(
      verifyCredentialIntegrity(credentialB, {
        trusted: { id: credentialB.proof.verificationMethod, publicKey: signing.publicKey },
        expectedIssuerId: credentialB.issuer,
      }),
    ).toMatchObject({ valid: false, reason: 'INVALID_SIGNATURE' })
  })

  it('o verificador remoto resolve a chave pelo issuer e recusa a chave do outro', async () => {
    const resolver = makeHttpIssuerResolver({ trustedIssuerOrigins: [ISSUER_ORIGIN], fetch: appFetch })
    const credentialA = await credentialOf(key.plaintext)
    const credentialB = await credentialOf(otherKey.plaintext)

    expect(
      await verifyCredentialFromIssuer(credentialA, resolver, {
        expectedIssuerId: credentialA.issuer,
        statusResolver,
      }),
    ).toMatchObject({ valid: true })
    expect(
      await verifyCredentialFromIssuer(credentialB, resolver, {
        expectedIssuerId: credentialB.issuer,
        statusResolver,
      }),
    ).toMatchObject({ valid: true })

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

  it('GET /.well-known/comprova-issuer/:scope descobre o MESMO documento público', async () => {
    const scope = issuerScopeOf(tenantId)
    const wellKnown = await app.inject({
      method: 'GET',
      url: `/.well-known/comprova-issuer/${scope}`,
    })
    const canonical = await app.inject({ method: 'GET', url: `/issuers/${scope}` })

    expect(canonical.statusCode).toBe(200)
    expect(wellKnown.statusCode).toBe(200)
    expect(wellKnown.json()).toEqual(canonical.json())

    const document = wellKnown.json() as {
      id: string
      verificationMethod: Array<Record<string, string>>
    }
    expect(document.id).toBe(issuerIdOf(ISSUER_ORIGIN, tenantId))
    expect(document.verificationMethod).toHaveLength(1)
    expect(Object.keys(document).sort()).toEqual(['id', 'verificationMethod'])
    expect(Object.keys(document.verificationMethod[0]!).sort()).toEqual([
      'controller',
      'id',
      'publicKeyMultibase',
      'type',
    ])

    // Só material público: nada de PEM/privada, tenant_id, API key, segredo de
    // configuração ou a chave (nem o escopo) do outro issuer.
    expect(wellKnown.body).not.toContain('PRIVATE KEY')
    expect(wellKnown.body).not.toContain(signing.privateKeyPkcs8Pem)
    expect(wellKnown.body).not.toContain(tenantId)
    expect(wellKnown.body).not.toContain(issuerScopeOf(otherTenantId))
    expect(wellKnown.body).not.toContain('api_key')
    expect(wellKnown.body).not.toContain('CREDENTIAL_SIGNING_KEYS')

    const missing = await app.inject({
      method: 'GET',
      url: `/.well-known/comprova-issuer/${'a'.repeat(43)}`,
    })
    expect(missing.statusCode).toBe(404)
  })

  it('descoberta + resolução da chave + verificação funciona ponta a ponta', async () => {
    const requested: string[] = []
    const discoveryFetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      requested.push(url.pathname)
      return appFetch(input)
    }) as typeof fetch
    const resolver = makeHttpIssuerResolver({
      trustedIssuerOrigins: [ISSUER_ORIGIN],
      fetch: discoveryFetch,
      discover: true,
    })

    const credentialA = await credentialOf(key.plaintext)
    expect(
      await verifyCredentialFromIssuer(credentialA, resolver, {
        expectedIssuerId: credentialA.issuer,
        statusResolver,
      }),
    ).toMatchObject({ valid: true })
    expect(requested).toEqual([`/.well-known/comprova-issuer/${issuerScopeOf(tenantId)}`])

    // Cada credencial descobre e resolve a chave do SEU issuer.
    requested.length = 0
    const credentialB = await credentialOf(otherKey.plaintext)
    expect(
      await verifyCredentialFromIssuer(credentialB, resolver, {
        expectedIssuerId: credentialB.issuer,
        statusResolver,
      }),
    ).toMatchObject({ valid: true })
    expect(requested).toEqual([`/.well-known/comprova-issuer/${issuerScopeOf(otherTenantId)}`])
  })

  it('descoberta não aceita método de outro issuer (recusa antes de buscar)', async () => {
    let fetched = false
    const resolver = makeHttpIssuerResolver({
      trustedIssuerOrigins: [ISSUER_ORIGIN],
      discover: true,
      fetch: (async () => {
        fetched = true
        throw new Error('should not fetch')
      }) as typeof fetch,
    })

    const credentialA = await credentialOf(key.plaintext)
    const credentialB = await credentialOf(otherKey.plaintext)
    const tampered = transport(credentialA)
    tampered.proof.verificationMethod = credentialB.proof.verificationMethod

    expect(await verifyCredentialFromIssuer(tampered, resolver)).toEqual({
      valid: false,
      reason: 'VERIFICATION_METHOD_MISMATCH',
    })
    expect(fetched).toBe(false)
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

  it('chave superada (active=false) não assina credenciais novas, mesmo com material configurado', async () => {
    // O material privado está em `CREDENTIAL_SIGNING_KEYS`; o que impede a
    // emissão é a chave publicada não estar ATIVA. Sem esta distinção, uma
    // rotação poderia continuar emitindo com a chave antiga.
    const validationId = await newValidationAs(supersededKey.plaintext)

    const res = await app.inject({
      method: 'POST',
      url: `/v1/validations/${validationId}/credential`,
      headers: { authorization: `Bearer ${supersededKey.plaintext}` },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('CREDENTIAL_NOT_ISSUABLE')
    expect(res.json().detail).toBe('SIGNING_KEY_UNAVAILABLE')
  })

  it('chave ativa sem material privado configurado falha fechado (não existe fallback global)', async () => {
    const unconfiguredTenant = await createTenant(adminPool.db, { name: 'credential-no-material' })
    const unconfiguredKey = await createApiKey(adminPool.db, unconfiguredTenant, PEPPER, {
      scopes: ['validate:read', 'validate:write'],
    })
    await createIssuerSigningKey(adminPool.db, unconfiguredTenant, createTestCredentialSigningKey(KEY_ID))
    const validationId = await newValidationAs(unconfiguredKey.plaintext)

    await expect(
      issueCredential(appPool.db, unconfiguredTenant, validationId, {
        issuerOrigin: ISSUER_ORIGIN,
        signingKeys,
      }),
    ).rejects.toMatchObject({ failure: 'SIGNING_KEY_UNAVAILABLE' })
  })

  it('não aceita a credencial de um tenant trocando issuer e verificationMethod para os do outro', async () => {
    const resolver = makeHttpIssuerResolver({ trustedIssuerOrigins: [ISSUER_ORIGIN], fetch: appFetch })
    const credentialA = await credentialOf(key.plaintext)
    const credentialB = await credentialOf(otherKey.plaintext)

    // Estruturalmente coerente (o método pertence ao issuer declarado), mas a
    // prova foi feita com a chave de A: o verificador resolve a chave publicada
    // de B e recusa a assinatura. Não há caminho para "usar a chave do outro".
    const tampered = transport(credentialA)
    tampered.issuer = credentialB.issuer
    tampered.proof.verificationMethod = credentialB.proof.verificationMethod

    expect(await verifyCredentialFromIssuer(tampered, resolver)).toEqual({
      valid: false,
      reason: 'INVALID_SIGNATURE',
    })
    // Com a expectativa do consumidor, a troca é recusada antes da resolução.
    expect(
      await verifyCredentialFromIssuer(tampered, resolver, {
        expectedIssuerId: credentialA.issuer,
      }),
    ).toMatchObject({ valid: false, reason: 'ISSUER_MISMATCH' })
  })
})

// ADR-0027 — status/revogação: o veredito assinado continua íntegro e o status
// público é consultado à parte. A revogação é monotônica e escopada ao tenant.
describe('status e revogação de credenciais', () => {
  const appFetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const res = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` })
    return new Response(res.body, {
      status: res.statusCode,
      headers: { 'content-type': String(res.headers['content-type'] ?? 'application/json') },
    })
  }) as typeof fetch

  const issuerResolver = makeHttpIssuerResolver({
    trustedIssuerOrigins: [ISSUER_ORIGIN],
    fetch: appFetch,
  })
  const statusResolver = makeHttpCredentialStatusResolver({
    trustedIssuerOrigins: [ISSUER_ORIGIN],
    fetch: appFetch,
  })

  const issueViaHttp = async (apiKey = key.plaintext): Promise<SecuredVerifiableCredential> => {
    const validationId = await newValidationAs(apiKey)
    const res = await app.inject({
      method: 'POST',
      url: `/v1/validations/${validationId}/credential`,
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(res.statusCode).toBe(200)
    return res.json() as SecuredVerifiableCredential
  }

  const credentialIdOfCredential = (credential: SecuredVerifiableCredential): string => {
    const id = credential.id
    if (id === undefined) throw new Error('credential id missing')
    return id.slice(id.lastIndexOf('/') + 1)
  }

  const statusUrlOf = (credential: SecuredVerifiableCredential): string => {
    const status = credential.credentialStatus
    if (status === undefined) throw new Error('credentialStatus missing')
    return new URL(status.id).pathname
  }

  const getStatus = (credential: SecuredVerifiableCredential) =>
    app.inject({ method: 'GET', url: statusUrlOf(credential) })

  const revoke = (credential: SecuredVerifiableCredential, apiKey = key.plaintext) =>
    app.inject({
      method: 'POST',
      url: `/v1/credentials/${credentialIdOfCredential(credential)}/revoke`,
      headers: { authorization: `Bearer ${apiKey}` },
    })

  const verify = (credential: SecuredVerifiableCredential) =>
    verifyCredentialFromIssuer(credential, issuerResolver, {
      expectedIssuerId: credential.issuer,
      statusResolver,
    })

  it('a emissão registra ACTIVE e publica só `{ status }` sem autenticação', async () => {
    const credential = await issueViaHttp()
    const credentialId = credentialIdOfCredential(credential)

    const rows = await adminPool.db
      .select()
      .from(t.credentialStatus)
      .where(eq(t.credentialStatus.credentialId, credentialId))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tenantId, status: 'ACTIVE', revokedAt: null })

    const res = await getStatus(credential)
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(JSON.stringify({ status: 'ACTIVE' }))
    for (const internal of [tenantId, credentialId, 'doc_hmac', 'validation_id', 'subject', 'evidence']) {
      expect(res.body).not.toContain(internal)
    }
    expect(await verify(credential)).toMatchObject({ valid: true })
  })

  it('revoga de forma monotônica, idempotente e sem reativar na reemissão', async () => {
    const validationId = await newValidation()
    const credential = await issueViaHttpFromValidation(validationId)
    expect(await verify(credential)).toMatchObject({ valid: true })

    const first = await revoke(credential)
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ status: 'REVOKED' })

    const second = await revoke(credential)
    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual({ status: 'REVOKED' })

    expect((await getStatus(credential)).json()).toEqual({ status: 'REVOKED' })
    // A credencial assinada continua íntegra; o status é que a recusa.
    expect(await verify(credential)).toMatchObject({ valid: false, reason: 'STATUS_REVOKED' })
    expect(verifyCredentialIntegrity(credential, { trusted }).valid).toBe(true)

    // Reemitir a MESMA validation reusa o credential_id e NÃO reativa.
    const reissued = await issueViaHttpFromValidation(validationId)
    expect(reissued.id).toBe(credential.id)
    expect(reissued.credentialStatus).toEqual(credential.credentialStatus)
    expect((await getStatus(reissued)).json()).toEqual({ status: 'REVOKED' })
    expect(await verify(reissued)).toMatchObject({ valid: false, reason: 'STATUS_REVOKED' })

    // Não existe rota de reativação.
    const reactivate = await app.inject({
      method: 'POST',
      url: `/v1/credentials/${credentialIdOfCredential(credential)}/reactivate`,
      headers: { authorization: `Bearer ${key.plaintext}` },
    })
    expect(reactivate.statusCode).toBe(404)
    expect((await getStatus(credential)).json()).toEqual({ status: 'REVOKED' })
  })

  it('isola tenants: B não revoga a credencial de A nem reativa a sua', async () => {
    const credentialA = await issueViaHttp()
    const credentialB = await issueViaHttp(otherKey.plaintext)
    expect(credentialA.id).not.toBe(credentialB.id)
    expect(credentialA.credentialStatus!.id).not.toBe(credentialB.credentialStatus!.id)

    expect((await revoke(credentialB, otherKey.plaintext)).json()).toEqual({ status: 'REVOKED' })
    expect((await getStatus(credentialA)).json()).toEqual({ status: 'ACTIVE' })

    // A tentativa de B sobre A é indistinguível de inexistente.
    const cross = await revoke(credentialA, otherKey.plaintext)
    expect(cross.statusCode).toBe(404)
    expect(cross.json().code).toBe('NOT_FOUND')
    expect((await getStatus(credentialA)).json()).toEqual({ status: 'ACTIVE' })
    expect(await verify(credentialA)).toMatchObject({ valid: true })

    // E A também não revoga B.
    expect((await revoke(credentialB)).statusCode).toBe(404)
  })

  it('credencial desconhecida: status 404 e revogação 404, sem vazar existência', async () => {
    const missingId = 'z'.repeat(43)
    const status = await app.inject({
      method: 'GET',
      url: `/issuers/${issuerScopeOf(tenantId)}/credentials/${missingId}/status`,
    })
    expect(status.statusCode).toBe(404)

    const revokeMissing = await app.inject({
      method: 'POST',
      url: `/v1/credentials/${missingId}/revoke`,
      headers: { authorization: `Bearer ${key.plaintext}` },
    })
    expect(revokeMissing.statusCode).toBe(404)
    expect(revokeMissing.json().code).toBe('NOT_FOUND')
  })

  it('exige autenticação para revogar', async () => {
    const credential = await issueViaHttp()
    const res = await app.inject({
      method: 'POST',
      url: `/v1/credentials/${credentialIdOfCredential(credential)}/revoke`,
    })
    expect(res.statusCode).toBe(401)
    expect((await getStatus(credential)).json()).toEqual({ status: 'ACTIVE' })
  })

  it('o status sobrevive à retenção do material de evidência', async () => {
    const validationId = await newValidation()
    const claimId = await claimIdOf(validationId)
    const credential = await issueViaHttpFromValidation(validationId)
    expect((await revoke(credential)).statusCode).toBe(200)

    const evidenceIds = await adminPool.db
      .select({ evidenceId: t.claimEvidence.evidenceId })
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimId, claimId))
    await adminPool.db
      .update(t.claimEvidence)
      .set({ evidenceId: null })
      .where(eq(t.claimEvidence.claimId, claimId))
    for (const row of evidenceIds) {
      if (row.evidenceId !== null) {
        await adminPool.db.delete(t.evidence).where(eq(t.evidence.evidenceId, row.evidenceId))
      }
    }

    expect((await getStatus(credential)).json()).toEqual({ status: 'REVOKED' })
    expect(await verify(credential)).toMatchObject({ valid: false, reason: 'STATUS_REVOKED' })
  })

  it('o banco recusa reativar uma linha REVOKED (defesa em profundidade)', async () => {
    const credential = await issueViaHttp()
    const credentialId = credentialIdOfCredential(credential)
    expect((await revoke(credential)).statusCode).toBe(200)

    // `ACTIVE` + `revoked_at = NULL` é consistente pelo CHECK; a única barreira
    // que recusa a transição é o trigger de monotonicidade.
    await expect(
      adminPool.db
        .update(t.credentialStatus)
        .set({ status: 'ACTIVE', revokedAt: null })
        .where(eq(t.credentialStatus.credentialId, credentialId)),
    ).rejects.toThrow()
    expect((await getStatus(credential)).json()).toEqual({ status: 'REVOKED' })
  })

  it('o app não pode apagar o status (sem DELETE; a revogação é monotônica)', async () => {
    const credential = await issueViaHttp()
    const credentialId = credentialIdOfCredential(credential)

    await expect(
      appPool.db.delete(t.credentialStatus).where(eq(t.credentialStatus.credentialId, credentialId)),
    ).rejects.toThrow()

    const rows = await adminPool.db
      .select()
      .from(t.credentialStatus)
      .where(eq(t.credentialStatus.credentialId, credentialId))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('ACTIVE')
  })

  it('revogações concorrentes convergem para REVOKED sem erro', async () => {
    const credential = await issueViaHttp()
    const responses = await Promise.all([revoke(credential), revoke(credential), revoke(credential)])
    for (const res of responses) {
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ status: 'REVOKED' })
    }
    expect((await getStatus(credential)).json()).toEqual({ status: 'REVOKED' })
    expect(await verify(credential)).toMatchObject({ valid: false, reason: 'STATUS_REVOKED' })
  })

  it('não emite credencial sem registrar ACTIVE (falha fechada)', async () => {
    // A emissão só devolve depois do INSERT; se o identificador calculado não
    // casar com a linha, o verificador não acharia o status. Aqui provamos o
    // contrato mínimo: toda credencial emitida tem exatamente uma linha.
    const credential = await issueViaHttp()
    const credentialId = credentialIdOfCredential(credential)
    const rows = await adminPool.db
      .select()
      .from(t.credentialStatus)
      .where(eq(t.credentialStatus.credentialId, credentialId))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('ACTIVE')
  })

  it('deriva o id do `validation_id` canônico do banco (caixa alta não duplica o status)', async () => {
    const validationId = await newValidation()
    const canonical = await issueViaHttpFromValidation(validationId)

    const upperRes = await app.inject({
      method: 'POST',
      url: `/v1/validations/${validationId.toUpperCase()}/credential`,
      headers: { authorization: `Bearer ${key.plaintext}` },
    })
    expect(upperRes.statusCode).toBe(200)
    const upper = upperRes.json() as SecuredVerifiableCredential
    expect(upper.id).toBe(canonical.id)
    expect(upper.credentialStatus).toEqual(canonical.credentialStatus)

    const rows = await adminPool.db
      .select()
      .from(t.credentialStatus)
      .where(eq(t.credentialStatus.credentialId, credentialIdOfCredential(canonical)))
    expect(rows).toHaveLength(1)
  })

  async function issueViaHttpFromValidation(validationId: string): Promise<SecuredVerifiableCredential> {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/validations/${validationId}/credential`,
      headers: { authorization: `Bearer ${key.plaintext}` },
    })
    expect(res.statusCode).toBe(200)
    return res.json() as SecuredVerifiableCredential
  }
})

// ADR-0028 — DID/DID Document do issuer: o DID é derivado do `issuer.id`
// (`did:web:<host>:issuers:<escopo>`), o documento é publicado em
// `<issuer.id>/did.json` e o verificador resolve a chave por ele — sem banco,
// chave privada nem API interna.
describe('DID e DID Document do issuer', () => {
  /** `fetch` que atravessa o roteador do Fastify (HTTP real, sem rede). */
  const appFetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const res = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` })
    return new Response(res.body, {
      status: res.statusCode,
      headers: { 'content-type': String(res.headers['content-type'] ?? 'application/json') },
    })
  }) as typeof fetch

  const statusResolver = makeHttpCredentialStatusResolver({
    trustedIssuerOrigins: [ISSUER_ORIGIN],
    fetch: appFetch,
  })

  const issue = async (apiKey = key.plaintext): Promise<SecuredVerifiableCredential> => {
    const validationId = await newValidationAs(apiKey)
    const res = await app.inject({
      method: 'POST',
      url: `/v1/validations/${validationId}/credential`,
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(res.statusCode).toBe(200)
    return res.json() as SecuredVerifiableCredential
  }

  const getDidDocument = (scope: string) => app.inject({ method: 'GET', url: `/issuers/${scope}/did.json` })

  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const resolverFrom = (
    handler: (url: string) => Response | Promise<Response>,
  ): ReturnType<typeof makeHttpDidResolver> =>
    makeHttpDidResolver({
      trustedIssuerOrigins: [ISSUER_ORIGIN],
      fetch: (async (input: string | URL | Request) =>
        handler(input instanceof Request ? input.url : input.toString())) as typeof fetch,
    })

  it('publica o DID Document resolvível por did:web, ligado ao issuer e só com material público', async () => {
    const scope = issuerScopeOf(tenantId)
    const issuerId = issuerIdOf(ISSUER_ORIGIN, tenantId)
    const did = didOfIssuer(issuerId)
    expect(didDocumentUrlOf(did)).toBe(`${issuerId}/did.json`)

    const res = await getDidDocument(scope)
    expect(res.statusCode).toBe(200)
    const document = res.json() as {
      '@context': string[]
      id: string
      alsoKnownAs: string[]
      verificationMethod: Array<{ id: string; type: string; controller: string; publicKeyMultibase: string }>
      assertionMethod: string[]
    }

    expect(document['@context']).toContain(DID_CONTEXT_URL)
    expect(document.id).toBe(did)
    expect(document.alsoKnownAs).toEqual([issuerId])
    expect(document.verificationMethod).toEqual([
      {
        id: didVerificationMethodOf(did, KEY_ID),
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: expect.stringMatching(/^z/),
      },
    ])
    expect(document.assertionMethod).toEqual([didVerificationMethodOf(did, KEY_ID)])
    expect(
      decodeEd25519PublicKeyMultibase(document.verificationMethod[0]!.publicKeyMultibase).equals(
        signing.publicKey,
      ),
    ).toBe(true)

    // Só material público: nada de privada, tenant_id, doc_hmac nem o outro issuer.
    expect(res.body).not.toContain('PRIVATE KEY')
    expect(res.body).not.toContain(signing.privateKeyPkcs8Pem)
    expect(res.body).not.toContain(tenantId)
    expect(res.body).not.toContain('doc_hmac')
    expect(res.body).not.toContain(issuerScopeOf(otherTenantId))

    expect((await getDidDocument('a'.repeat(43))).statusCode).toBe(404)
  })

  it('isola o DID Document por issuer', async () => {
    const docA = (await getDidDocument(issuerScopeOf(tenantId))).json()
    const docB = (await getDidDocument(issuerScopeOf(otherTenantId))).json()

    expect(docA.id).toBe(didOfIssuer(issuerIdOf(ISSUER_ORIGIN, tenantId)))
    expect(docB.id).toBe(didOfIssuer(issuerIdOf(ISSUER_ORIGIN, otherTenantId)))
    expect(docA.id).not.toBe(docB.id)
    expect(docA.verificationMethod[0].publicKeyMultibase).not.toBe(
      docB.verificationMethod[0].publicKeyMultibase,
    )
    expect(JSON.stringify(docA)).not.toContain(issuerScopeOf(otherTenantId))
    expect(JSON.stringify(docB)).not.toContain(issuerScopeOf(tenantId))
  })

  it('resolve o DID Document via HTTP, extrai a chave e verifica a credencial ponta a ponta (VALID)', async () => {
    const credential = await issue()
    const scope = issuerScopeOf(tenantId)
    expect(credential.issuer).toBe(issuerIdOf(ISSUER_ORIGIN, tenantId))

    // Coerência de identidade: o DID é DERIVADO do issuer HTTPS, o documento
    // declara o mesmo issuer em `alsoKnownAs` e o método da credencial
    // (`<issuer>#<keyId>`) aponta para o método DID (`<did>#<keyId>`).
    const did = didOfIssuer(credential.issuer)
    const document = (await getDidDocument(scope)).json() as {
      id: string
      alsoKnownAs: string[]
      verificationMethod: Array<{
        id: string
        controller: string
        publicKeyMultibase: string
      }>
    }
    expect(document.id).toBe(did)
    expect(document.alsoKnownAs).toEqual([credential.issuer])
    expect(credential.proof.verificationMethod).toBe(`${credential.issuer}#${KEY_ID}`)
    const methodId = didVerificationMethodOf(did, KEY_ID)
    const method = document.verificationMethod.find((entry) => entry.id === methodId)
    expect(method).toBeDefined()
    expect(method?.controller).toBe(did)

    // A chave extraída do DID Document verifica a assinatura emitida pela rota
    // real. O `id` confiável continua sendo o HTTPS da credencial: o DID é uma
    // forma de DESCOBRIR a chave, não um segundo `issuer`.
    const publicKey = decodeEd25519PublicKeyMultibase(method!.publicKeyMultibase)
    expect(
      verifyCredentialIntegrity(credential, {
        trusted: { id: credential.proof.verificationMethod, publicKey },
        expectedIssuerId: credential.issuer,
      }),
    ).toMatchObject({ valid: true })

    // O mesmo caminho, agora com a resolução DID completa.
    const requested: string[] = []
    const resolver = resolverFrom((url) => {
      requested.push(new URL(url).pathname)
      return appFetch(url)
    })
    expect(
      await verifyCredentialFromIssuer(credential, resolver, {
        expectedIssuerId: credential.issuer,
        statusResolver,
      }),
    ).toMatchObject({ valid: true })
    expect(requested).toEqual([`/issuers/${scope}/did.json`])
  })

  it('recusa credencial de A com issuer/verificationMethod de B (INVALID_SIGNATURE)', async () => {
    const credentialA = await issue()
    const credentialB = await issue(otherKey.plaintext)
    const resolver = resolverFrom(() => appFetch(didDocumentUrlOf(didOfIssuer(credentialB.issuer))))

    const tampered = transport(credentialA)
    tampered.issuer = credentialB.issuer
    tampered.proof.verificationMethod = credentialB.proof.verificationMethod

    // A chave de B resolve, mas a assinatura é de A — nunca passa.
    expect(await verifyCredentialFromIssuer(tampered, resolver)).toEqual({
      valid: false,
      reason: 'INVALID_SIGNATURE',
    })
  })

  it('DID Document com chave diferente não verifica a credencial (INVALID_SIGNATURE)', async () => {
    const credential = await issue()
    const scope = issuerScopeOf(tenantId)
    const resolver = resolverFrom(async (url) => {
      if (new URL(url).pathname !== `/issuers/${scope}/did.json`) return appFetch(url)
      const document = (await getDidDocument(scope)).json() as {
        verificationMethod: Array<{ publicKeyMultibase: string }>
      }
      document.verificationMethod[0]!.publicKeyMultibase = encodeEd25519PublicKeyMultibase(
        otherSigning.publicKey,
      )
      return jsonResponse(document)
    })

    expect(await verifyCredentialFromIssuer(credential, resolver, { statusResolver })).toEqual({
      valid: false,
      reason: 'INVALID_SIGNATURE',
    })
  })

  it('DID Document adulterado (id, alsoKnownAs, assertionMethod, controller) não resolve', async () => {
    const credential = await issue()
    const original = (await getDidDocument(issuerScopeOf(tenantId))).json() as {
      verificationMethod: Array<Record<string, string>>
      [key: string]: unknown
    }
    const otherDid = didOfIssuer(issuerIdOf(ISSUER_ORIGIN, otherTenantId))

    const variants = [
      { ...original, id: otherDid },
      { ...original, alsoKnownAs: [issuerIdOf(ISSUER_ORIGIN, otherTenantId)] },
      { ...original, assertionMethod: [] },
      { ...original, verificationMethod: [{ ...original.verificationMethod[0]!, controller: otherDid }] },
    ]

    for (const variant of variants) {
      const resolver = resolverFrom(() => jsonResponse(variant))
      expect(await verifyCredentialFromIssuer(credential, resolver, { statusResolver })).toEqual({
        valid: false,
        reason: 'VERIFICATION_METHOD_UNRESOLVED',
      })
    }
  })
})

// ADR-0029 — `active = false` é ROTAÇÃO (a chave continua publicada para o
// passado); `revoked_at` é o hard stop, inclusive para credenciais já emitidas.
// A revogação remove a chave dos documentos públicos e o verificador falha
// fechado, sem "ignorar" o método desconhecido.
describe('revogação e expiração da chave de assinatura', () => {
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
  const statusResolver = makeHttpCredentialStatusResolver({
    trustedIssuerOrigins: [ISSUER_ORIGIN],
    fetch: appFetch,
  })

  const issueAs = async (apiKey: string): Promise<SecuredVerifiableCredential> => {
    const validationId = await newValidationAs(apiKey)
    const res = await app.inject({
      method: 'POST',
      url: `/v1/validations/${validationId}/credential`,
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(res.statusCode).toBe(200)
    return res.json() as SecuredVerifiableCredential
  }

  const revoke = (apiKey: string, keyId: string, effectiveAt?: string) =>
    app.inject({
      method: 'POST',
      url:
        `/v1/signing-keys/${encodeURIComponent(keyId)}/revoke` +
        (effectiveAt === undefined ? '' : `?effective_at=${encodeURIComponent(effectiveAt)}`),
      headers: { authorization: `Bearer ${apiKey}` },
    })

  const documentOf = (tenant: string) =>
    app.inject({ method: 'GET', url: `/issuers/${issuerScopeOf(tenant)}` })
  const didDocumentOf = (tenant: string) =>
    app.inject({ method: 'GET', url: `/issuers/${issuerScopeOf(tenant)}/did.json` })

  const methodOf = (tenant: string, keyId: string) =>
    verificationMethodOf(localIssuer(ISSUER_ORIGIN, tenant, keyId))
  const didMethodOf = (tenant: string, keyId: string) =>
    didVerificationMethodOf(didOfIssuer(issuerIdOf(ISSUER_ORIGIN, tenant)), keyId)

  it('exige keys:write: API key somente-leitura recebe 403 e não revoga', async () => {
    const res = await revoke(readOnlyKey.plaintext, readOnlySigning.keyId)
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('FORBIDDEN')
    // A chave continua publicada: o 403 não chegou ao serviço de revogação.
    expect((await documentOf(readOnlyTenantId)).statusCode).toBe(200)
  })

  it('revoga a chave ativa: sai dos documentos públicos e a credencial anterior falha fechado', async () => {
    const credential = await issueAs(lifecycleKey.plaintext)

    // Antes: publicada e verificável.
    expect((await documentOf(lifecycleTenantId)).statusCode).toBe(200)
    expect(
      await verifyCredentialFromIssuer(credential, resolver, {
        expectedIssuerId: credential.issuer,
        statusResolver,
      }),
    ).toMatchObject({ valid: true })

    const res = await revoke(lifecycleKey.plaintext, lifecycleSigning.keyId)
    expect(res.statusCode).toBe(200)
    const body = res.json() as { key_id: string; revoked_at: string }
    expect(body.key_id).toBe(lifecycleSigning.keyId)
    expect(Number.isNaN(Date.parse(body.revoked_at))).toBe(false)

    // Depois: sem chave confiável, os dois documentos públicos somem (404) e o
    // verificador não resolve o método — fail closed.
    expect((await documentOf(lifecycleTenantId)).statusCode).toBe(404)
    expect((await didDocumentOf(lifecycleTenantId)).statusCode).toBe(404)
    expect(
      await verifyCredentialFromIssuer(credential, resolver, {
        expectedIssuerId: credential.issuer,
        statusResolver,
      }),
    ).toMatchObject({ valid: false, reason: 'VERIFICATION_METHOD_UNRESOLVED' })

    // A emissão nova também falha: a chave ativa foi revogada.
    const validationId = await newValidationAs(lifecycleKey.plaintext)
    const issuance = await app.inject({
      method: 'POST',
      url: `/v1/validations/${validationId}/credential`,
      headers: { authorization: `Bearer ${lifecycleKey.plaintext}` },
    })
    expect(issuance.statusCode).toBe(409)
    expect(issuance.json().detail).toBe('SIGNING_KEY_UNAVAILABLE')

    // Idempotente/monotônica: repetir devolve o MESMO instante e não reativa.
    const again = await revoke(lifecycleKey.plaintext, lifecycleSigning.keyId)
    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual(body)
    expect((await documentOf(lifecycleTenantId)).statusCode).toBe(404)
  })

  it('isola tenants, não vaza existência e exige autenticação', async () => {
    // A chave de outro tenant é indistinguível de uma inexistente: 404.
    for (const keyId of [KEY_ID, 'missing-key']) {
      const res = await revoke(lifecycleKey.plaintext, keyId)
      expect(res.statusCode).toBe(404)
      expect(res.json().code).toBe('NOT_FOUND')
    }
    // A chave de A continua publicada/ativa: a tentativa de B não a tocou.
    const docA = await documentOf(tenantId)
    expect(docA.statusCode).toBe(200)
    expect(docA.json().verificationMethod).toHaveLength(1)

    const unauth = await app.inject({
      method: 'POST',
      url: `/v1/signing-keys/${KEY_ID}/revoke`,
    })
    expect(unauth.statusCode).toBe(401)
  })

  it('agenda a expiração sem derrubar a chave antes do instante', async () => {
    const credential = await issueAs(scheduledKey.plaintext)
    const future = new Date(Date.now() + 3_600_000).toISOString()

    const res = await revoke(scheduledKey.plaintext, scheduledSigning.keyId, future)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ key_id: scheduledSigning.keyId, revoked_at: future })

    // Ainda publicada, ativa e verificável até o instante agendado.
    const doc = await documentOf(scheduledTenantId)
    expect(doc.statusCode).toBe(200)
    expect(doc.json().verificationMethod).toHaveLength(1)
    expect(
      await verifyCredentialFromIssuer(credential, resolver, {
        expectedIssuerId: credential.issuer,
        statusResolver,
      }),
    ).toMatchObject({ valid: true })
    const renewed = await issueAs(scheduledKey.plaintext)
    expect(renewed.proof.verificationMethod).toBe(methodOf(scheduledTenantId, scheduledSigning.keyId))

    // Adiar não reescreve o instante já registrado.
    const later = new Date(Date.now() + 7_200_000).toISOString()
    const again = await revoke(scheduledKey.plaintext, scheduledSigning.keyId, later)
    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual({ key_id: scheduledSigning.keyId, revoked_at: future })

    // Antecipar é permitido: uma chave comprometida com expiração agendada
    // pode ser revogada agora. A confiança só encolhe.
    const emergency = await revoke(scheduledKey.plaintext, scheduledSigning.keyId)
    expect(emergency.statusCode).toBe(200)
    const emergencyBody = emergency.json() as { key_id: string; revoked_at: string }
    expect(emergencyBody.key_id).toBe(scheduledSigning.keyId)
    expect(Date.parse(emergencyBody.revoked_at)).toBeLessThan(Date.parse(future))

    expect((await documentOf(scheduledTenantId)).statusCode).toBe(404)
    expect(
      await verifyCredentialFromIssuer(credential, resolver, {
        expectedIssuerId: credential.issuer,
        statusResolver,
      }),
    ).toMatchObject({ valid: false, reason: 'VERIFICATION_METHOD_UNRESOLVED' })
  })

  it('rotação (active=false) continua publicada; revogar remove só a chave revogada', async () => {
    const oldCredential = await issueAs(rotationKey.plaintext)
    expect(oldCredential.proof.verificationMethod).toBe(methodOf(rotationTenantId, rotationOldSigning.keyId))

    // Rotação: a antiga deixa de assinar, a nova passa a assinar. Nenhuma é
    // revogada; a antiga continua publicada para verificar o passado.
    await adminPool.db
      .update(t.issuerSigningKey)
      .set({ active: false })
      .where(
        and(
          eq(t.issuerSigningKey.tenantId, rotationTenantId),
          eq(t.issuerSigningKey.keyId, rotationOldSigning.keyId),
        ),
      )
    await adminPool.db
      .update(t.issuerSigningKey)
      .set({ active: true })
      .where(
        and(
          eq(t.issuerSigningKey.tenantId, rotationTenantId),
          eq(t.issuerSigningKey.keyId, rotationNewSigning.keyId),
        ),
      )

    const rotated = await documentOf(rotationTenantId)
    expect(rotated.statusCode).toBe(200)
    expect(rotated.json().verificationMethod.map((method: { id: string }) => method.id)).toEqual([
      methodOf(rotationTenantId, rotationNewSigning.keyId),
      methodOf(rotationTenantId, rotationOldSigning.keyId),
    ])
    expect(
      await verifyCredentialFromIssuer(oldCredential, resolver, {
        expectedIssuerId: oldCredential.issuer,
        statusResolver,
      }),
    ).toMatchObject({ valid: true })

    const newCredential = await issueAs(rotationKey.plaintext)
    expect(newCredential.proof.verificationMethod).toBe(methodOf(rotationTenantId, rotationNewSigning.keyId))

    // Revogar a ANTIGA remove só ela dos documentos públicos. A nova continua
    // publicada e as credenciais antigas assinadas pela revogada falham fechado.
    const res = await revoke(rotationKey.plaintext, rotationOldSigning.keyId)
    expect(res.statusCode).toBe(200)
    const after = await documentOf(rotationTenantId)
    expect(after.statusCode).toBe(200)
    expect(after.json().verificationMethod.map((method: { id: string }) => method.id)).toEqual([
      methodOf(rotationTenantId, rotationNewSigning.keyId),
    ])
    expect(
      await verifyCredentialFromIssuer(oldCredential, resolver, {
        expectedIssuerId: oldCredential.issuer,
        statusResolver,
      }),
    ).toMatchObject({ valid: false, reason: 'VERIFICATION_METHOD_UNRESOLVED' })
    expect(
      await verifyCredentialFromIssuer(newCredential, resolver, {
        expectedIssuerId: newCredential.issuer,
        statusResolver,
      }),
    ).toMatchObject({ valid: true })

    const did = await didDocumentOf(rotationTenantId)
    expect(did.statusCode).toBe(200)
    expect(did.json().assertionMethod).toEqual([didMethodOf(rotationTenantId, rotationNewSigning.keyId)])
  })
})
