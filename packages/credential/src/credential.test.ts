import { evidenceSetHashOfObservations } from '@comprova/core'
import { describe, expect, it } from 'vitest'
import type { AssertionObservation, AssertionSource } from './assertion.js'
import { buildCredential } from './credential.js'
import { verificationMethodOf, type IssuerIdentity, localIssuer } from './issuer.js'
import { generateEd25519KeyPair, makeEd25519Signer } from './signer.js'
import { VC_CONTEXT_URL, type SecuredVerifiableCredential } from './vc.js'
import { verifyCredential } from './verifier.js'

const TENANT = '11111111-1111-4111-8111-111111111111'
const VALIDATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CLAIM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ADDRESS_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const observation = (
  overrides: Partial<AssertionObservation> & { readonly id: string },
): AssertionObservation => ({
  checker: 'registry_match',
  checkerVersion: '1',
  stance: 'supports',
  strength: 0.9,
  confidence: 0.8,
  source: 'receita',
  observedAt: new Date('2026-01-02T03:04:05.000Z'),
  evidenceSha256: null,
  detail: { nested: { b: 2, a: 1 } },
  ...overrides,
})

const source = (
  observations: AssertionObservation[],
  validationOverrides: Partial<AssertionSource['validation']> = {},
): AssertionSource => ({
  tenantId: TENANT,
  validation: {
    id: VALIDATION_ID,
    verdict: 'CONFIRMED_COMMERCIAL',
    score: 0.9,
    confidence: 0.8,
    policyVersion: '2026.13.1',
    policyHash: 'd'.repeat(64),
    scorerVersion: '1',
    evidenceSetHash: evidenceSetHashOfObservations(observations),
    legalBasis: 'FRAUD_PREVENTION',
    issuerScopes: ['validate:write'],
    explanation: {
      code: 'ADDRESS_CONFIRMED',
      summary: 'ok',
      supporting_evidence: ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001'],
      contradicting_evidence: [],
    },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    completedAt: new Date('2026-01-01T00:00:01.000Z'),
    expiresAt: new Date('2026-01-31T00:00:00.000Z'),
    ...validationOverrides,
  },
  subject: { docType: 'CNPJ', docHmac: Buffer.alloc(32, 7) },
  claim: {
    id: CLAIM_ID,
    type: 'business_registered_address',
    subjectType: 'organization',
    targetType: 'address',
    addressId: ADDRESS_ID,
  },
  addressBuildingKey: 'b64:AAAA',
  observations,
})

const keyPair = generateEd25519KeyPair()
const issuer: IssuerIdentity = localIssuer(TENANT, 'key-1')
const signer = makeEd25519Signer(keyPair.privateKey)

const twoObservations = (): AssertionObservation[] => [
  observation({
    id: '00000000-0000-4000-8000-000000000002',
    stance: 'contradicts',
    evidenceSha256: Buffer.alloc(32, 9),
  }),
  observation({ id: '00000000-0000-4000-8000-000000000001' }),
]

const emit = async (observations = twoObservations()): Promise<SecuredVerifiableCredential> =>
  buildCredential(source(observations), { issuer, signer })

const transport = (credential: SecuredVerifiableCredential): SecuredVerifiableCredential =>
  JSON.parse(JSON.stringify(credential)) as SecuredVerifiableCredential

/** Inverte recursivamente a ordem das chaves (a ordem de arrays é preservada). */
const reverseKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, entry]) => [key, reverseKeys(entry)]),
    )
  }
  return value
}

describe('buildCredential + verifyCredential', () => {
  it('emite uma VC 2.0 que espelha a assertion', async () => {
    const credential = await emit()

    expect(credential['@context'][0]).toBe(VC_CONTEXT_URL)
    expect(credential.type).toEqual(['VerifiableCredential', 'comprova:AddressCredential'])
    expect(credential.issuer).toBe(`comprova:issuer:${TENANT}`)
    expect(credential.validFrom).toBe('2026-01-01T00:00:00.000Z')
    expect(credential.validUntil).toBe('2026-01-31T00:00:00.000Z')
    expect(credential.credentialSubject.id).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(credential.credentialSubject['comprova:docType']).toBe('CNPJ')
    expect(credential.credentialSubject['comprova:claim'].id).toBe(`urn:uuid:${CLAIM_ID}`)
    expect(credential.credentialSubject['comprova:claim']['comprova:address']).toEqual({
      id: `urn:uuid:${ADDRESS_ID}`,
      'comprova:buildingKey': 'b64:AAAA',
    })
    expect(credential.evidence).toHaveLength(2)
    expect(credential['comprova:evidenceSetHash']).toMatch(/^[0-9a-f]{64}$/)
    expect(credential['comprova:result']['comprova:verdict']).toBe('CONFIRMED_COMMERCIAL')
    expect(credential['comprova:policy']).toEqual({
      'comprova:version': '2026.13.1',
      'comprova:hash': 'd'.repeat(64),
    })
    expect(credential['comprova:algorithm']).toEqual({ 'comprova:scorerVersion': '1' })
    expect(credential['comprova:authorization']).toEqual({ 'comprova:scopes': ['validate:write'] })
    expect(credential.proof.type).toBe('DataIntegrityProof')
    expect(credential.proof.cryptosuite).toBe('eddsa-jcs-2022')
    expect(credential.proof.proofPurpose).toBe('assertionMethod')
    expect(credential.proof.verificationMethod).toBe(`comprova:issuer:${TENANT}#key-1`)
    expect(credential.proof.proofValue).toMatch(/^z[1-9A-HJ-NP-Za-km-z]+$/)
  })

  it('é verificável por um processo independente que só recebe a credencial e a chave pública', async () => {
    const credential = transport(await emit())
    expect(
      verifyCredential(credential, {
        publicKey: keyPair.publicKey,
        expectedIssuerId: issuer.id,
        expectedVerificationMethod: verificationMethodOf(issuer),
      }),
    ).toEqual({ valid: true })
  })

  it('é autocontida: o JSON transportado verifica sem nenhum dado além da chave pública', async () => {
    const credential = transport(await emit())

    // Nenhuma dependência de PostgreSQL/Redis/Temporal/S3/API: o verificador só
    // recebe o documento e a chave pública.
    expect(verifyCredential(credential, { publicKey: keyPair.publicKey })).toEqual({ valid: true })

    const json = JSON.stringify(credential)
    for (const internal of [
      'validation_id',
      'validationId',
      'evidence_id',
      's3_uri',
      'doc_hmac',
      'doc_enc',
    ]) {
      expect(json).not.toContain(internal)
    }
  })

  it('não assina o ponteiro material: um `evidence_id` distinto produz a mesma prova', async () => {
    const withoutPointer = await emit()
    const withPointer: AssertionObservation[] = twoObservations().map((observation, index) => ({
      ...observation,
      evidenceId: `s3-${index}`,
    }))
    const other = await buildCredential(source(withPointer), { issuer, signer })

    expect(other.proof.proofValue).toBe(withoutPointer.proof.proofValue)
  })

  it('é determinística: a ordem das observações vinda do banco não muda os bytes assinados', async () => {
    const forward = await emit(twoObservations())
    const backward = await emit([...twoObservations()].reverse())
    expect(backward.proof.proofValue).toBe(forward.proof.proofValue)
  })

  it('é determinística: a ordem das propriedades JSON não muda o material assinado nem a verificação', async () => {
    const credential = await emit()

    // Reordenar recursivamente as chaves de todo o documento não pode mudar o
    // proof (JCS ordena as propriedades) nem invalidar a verificação.
    const reversed = reverseKeys(credential) as SecuredVerifiableCredential
    expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(credential))
    expect(
      verifyCredential(reversed, {
        publicKey: keyPair.publicKey,
        expectedVerificationMethod: verificationMethodOf(issuer),
      }),
    ).toEqual({ valid: true })
  })

  it('preserva evidence_sha256 sem depender de evidence_id', async () => {
    const credential = await emit()
    const linked = credential.evidence.find((e) => e.id === 'urn:uuid:00000000-0000-4000-8000-000000000002')
    expect(linked?.['comprova:evidenceSha256']).toBe(Buffer.alloc(32, 9).toString('hex'))
    expect(JSON.stringify(credential)).not.toContain('evidence_id')
    expect(JSON.stringify(credential)).not.toContain('s3_uri')
  })

  it('recusa emitir quando o resultado não está final ou faltam bindings', async () => {
    await expect(
      buildCredential(source(twoObservations(), { verdict: null }), { issuer, signer }),
    ).rejects.toThrow(/incomplete/)
    await expect(
      buildCredential(source(twoObservations(), { evidenceSetHash: null }), { issuer, signer }),
    ).rejects.toThrow(/bindings/)
    await expect(
      buildCredential(source(twoObservations(), { evidenceSetHash: 'f'.repeat(64) }), { issuer, signer }),
    ).rejects.toThrow(/mismatch/)
  })
})

describe('adulteração da credencial', () => {
  const valid = async (): Promise<SecuredVerifiableCredential> => transport(await emit())

  const expectInvalid = async (mutate: (credential: SecuredVerifiableCredential) => void): Promise<void> => {
    const credential = await valid()
    mutate(credential)
    expect(verifyCredential(credential, { publicKey: keyPair.publicKey }).valid).toBe(false)
  }

  it('detecta alteração em issuer, subject, claim e endereço', async () => {
    await expectInvalid((c) => {
      c.issuer = 'comprova:issuer:99999999-9999-4999-8999-999999999999'
    })
    await expectInvalid((c) => {
      c.credentialSubject.id = 'sha256:' + 'f'.repeat(64)
    })
    await expectInvalid((c) => {
      c.credentialSubject['comprova:claim']['comprova:claimType'] = 'address_exists'
    })
    await expectInvalid((c) => {
      ;(c.credentialSubject['comprova:claim'] as Record<string, unknown>)['comprova:targetType'] = 'parcel'
    })
    await expectInvalid((c) => {
      c.credentialSubject['comprova:claim']['comprova:address'].id =
        'urn:uuid:99999999-9999-4999-8999-999999999999'
    })
    await expectInvalid((c) => {
      c.credentialSubject['comprova:claim']['comprova:address']['comprova:buildingKey'] = 'b64:BBBB'
    })
  })

  it('detecta alteração no resultado', async () => {
    await expectInvalid((c) => {
      c['comprova:result']['comprova:verdict'] = 'NOT_FOUND'
    })
    await expectInvalid((c) => {
      c['comprova:result']['comprova:score'] = 0.1
    })
    await expectInvalid((c) => {
      c['comprova:result']['comprova:confidence'] = 0.1
    })
    await expectInvalid((c) => {
      delete c['comprova:result']['comprova:explanation']
    })
  })

  it('detecta alteração nos bindings de policy, algoritmo e evidência', async () => {
    await expectInvalid((c) => {
      c['comprova:policy']['comprova:hash'] = 'a'.repeat(64)
    })
    await expectInvalid((c) => {
      c['comprova:policy']['comprova:version'] = '2026.99.9'
    })
    await expectInvalid((c) => {
      c['comprova:algorithm']['comprova:scorerVersion'] = '2'
    })
    await expectInvalid((c) => {
      c['comprova:evidenceSetHash'] = 'b'.repeat(64)
    })
  })

  it('detecta alteração na janela de validade, no digest e no detalhe da evidência', async () => {
    await expectInvalid((c) => {
      c.validFrom = '2000-01-01T00:00:00.000Z'
    })
    await expectInvalid((c) => {
      c['comprova:result']['comprova:completedAt'] = '2000-01-01T00:00:00.000Z'
    })
    await expectInvalid((c) => {
      c.evidence[0]!['comprova:evidenceSha256'] = 'a'.repeat(64)
    })
    await expectInvalid((c) => {
      c.evidence[0]!['comprova:detail'] = { nested: { a: 1, b: 3 } }
    })
    await expectInvalid((c) => {
      c.proof.proofValue = c.proof.proofValue.slice(0, -1) + (c.proof.proofValue.endsWith('A') ? 'B' : 'A')
    })
  })

  it('classifica falhas estruturais, de contexto, issuer e chave', async () => {
    expect(verifyCredential({}, { publicKey: keyPair.publicKey })).toEqual({
      valid: false,
      reason: 'MALFORMED_CREDENTIAL',
    })
    expect(verifyCredential([], { publicKey: keyPair.publicKey })).toEqual({
      valid: false,
      reason: 'MALFORMED_CREDENTIAL',
    })

    const credential = await valid()
    expect(
      verifyCredential(
        { ...credential, '@context': ['https://example.org'] },
        { publicKey: keyPair.publicKey },
      ),
    ).toEqual({ valid: false, reason: 'UNSUPPORTED_CREDENTIAL' })

    expect(verifyCredential(credential, { publicKey: keyPair.publicKey, expectedIssuerId: 'x' })).toEqual({
      valid: false,
      reason: 'ISSUER_MISMATCH',
    })
    expect(
      verifyCredential(credential, { publicKey: keyPair.publicKey, expectedVerificationMethod: 'other#key' }),
    ).toEqual({ valid: false, reason: 'VERIFICATION_METHOD_MISMATCH' })

    const otherKey = generateEd25519KeyPair()
    expect(verifyCredential(credential, { publicKey: otherKey.publicKey })).toEqual({
      valid: false,
      reason: 'INVALID_SIGNATURE',
    })
  })

  it('amarra o `verificationMethod` ao issuer declarado (§5.9)', async () => {
    // Sem resolução de chave, o binding é estrutural: um proof válido de outro
    // issuer (ou o próprio issuer com o método alterado) não pode se declarar
    // emitido por este issuer.
    const credential = await valid()
    credential.proof.verificationMethod = 'comprova:issuer:99999999-9999-4999-8999-999999999999#key-1'
    expect(verifyCredential(credential, { publicKey: keyPair.publicKey })).toEqual({
      valid: false,
      reason: 'VERIFICATION_METHOD_MISMATCH',
    })

    const noFragment = await valid()
    noFragment.proof.verificationMethod = `comprova:issuer:${TENANT}#`
    expect(verifyCredential(noFragment, { publicKey: keyPair.publicKey })).toEqual({
      valid: false,
      reason: 'VERIFICATION_METHOD_MISMATCH',
    })
  })

  it('exige `proofPurpose: assertionMethod` (uma prova para outro motivo não vale como credencial)', async () => {
    const credential = await valid()
    credential.proof.proofPurpose = 'authentication'
    expect(verifyCredential(credential, { publicKey: keyPair.publicKey })).toEqual({
      valid: false,
      reason: 'PROOF_PURPOSE_MISMATCH',
    })
  })

  it('detecta incoerência entre o conjunto de evidências e o evidence_set_hash', async () => {
    const credential = await valid()
    // Adultera o conjunto E re-sela o hash: a assinatura continua cobrindo os
    // dois, então a falha aparece como assinatura inválida — o binding é o que
    // garante a amarração.
    credential.evidence = credential.evidence.slice(0, 1)
    expect(verifyCredential(credential, { publicKey: keyPair.publicKey })).toEqual({
      valid: false,
      reason: 'EVIDENCE_SET_MISMATCH',
    })
  })

  it('recusa documentos sem os membros obrigatórios da VC', async () => {
    const credential = await valid()

    for (const member of ['@context', 'type', 'issuer', 'credentialSubject', 'proof'] as const) {
      const incomplete = { ...credential } as Record<string, unknown>
      delete incomplete[member]
      expect(verifyCredential(incomplete, { publicKey: keyPair.publicKey }), member).toEqual({
        valid: false,
        reason: 'MALFORMED_CREDENTIAL',
      })
    }
  })

  it('recusa cryptosuite inesperada e proof sem os campos exigidos', async () => {
    const credential = await valid()
    credential.proof.cryptosuite = 'eddsa-rdfc-2022'
    expect(verifyCredential(credential, { publicKey: keyPair.publicKey })).toEqual({
      valid: false,
      reason: 'UNSUPPORTED_CRYPTOSUITE',
    })

    const noPurpose = await valid()
    ;(noPurpose.proof as Record<string, unknown>).proofPurpose = undefined
    expect(verifyCredential(noPurpose, { publicKey: keyPair.publicKey })).toEqual({
      valid: false,
      reason: 'MALFORMED_CREDENTIAL',
    })

    const noMethod = await valid()
    ;(noMethod.proof as Record<string, unknown>).verificationMethod = undefined
    expect(verifyCredential(noMethod, { publicKey: keyPair.publicKey })).toEqual({
      valid: false,
      reason: 'MALFORMED_CREDENTIAL',
    })
  })
})
