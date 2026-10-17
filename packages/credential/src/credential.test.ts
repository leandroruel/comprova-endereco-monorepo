import { evidenceSetHashOfObservations } from '@comprova/core'
import { describe, expect, it } from 'vitest'
import type { AssertionObservation, AssertionSource, Credential } from './assertion.js'
import { canonicalAssertion } from './canonical.js'
import { buildCredential } from './credential.js'
import type { IssuerIdentity } from './issuer.js'
import { localIssuer } from './issuer.js'
import { generateEd25519KeyPair, makeEd25519Signer } from './signer.js'
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

const emit = async (observations = twoObservations()): Promise<Credential> =>
  buildCredential(source(observations), { issuer, signer })

const transport = (credential: Credential): Credential => JSON.parse(JSON.stringify(credential)) as Credential

describe('buildCredential + verifyCredential', () => {
  it('emite uma credencial cujo payload espelha a assertion', async () => {
    const credential = await emit()

    expect(credential.payload.format).toBe('comprova-assertion-v1')
    expect(credential.payload.issuer.id).toBe(`comprova:issuer:${TENANT}`)
    expect(credential.payload.issuer.authorization).toEqual({ scopes: ['validate:write'] })
    expect(credential.payload.subject.id).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(credential.payload.claim.id).toBe(CLAIM_ID)
    expect(credential.payload.claim.target.id).toBe(ADDRESS_ID)
    expect(credential.payload.evidence.set_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(credential.payload.evidence.summary).toEqual({ supporting: 1, contradicting: 1, unknown: 0 })
    expect(credential.payload.evidence.observations).toHaveLength(2)
    expect(credential.payload.policy).toEqual({ version: '2026.13.1', hash: 'd'.repeat(64) })
    expect(credential.payload.algorithm.scorer_version).toBe('1')
    expect(credential.payload.result.status).toBe('completed')
    expect(credential.proof.type).toBe('Ed25519Signature')
    expect(credential.proof.key_id).toBe('key-1')
  })

  it('é verificável por um processo independente que só recebe a credencial e a chave pública', async () => {
    const credential = transport(await emit())
    expect(
      verifyCredential(credential, {
        publicKey: keyPair.publicKey,
        expectedIssuerId: issuer.id,
        expectedKeyId: 'key-1',
      }),
    ).toEqual({ valid: true })
  })

  it('é determinística: a ordem das observações vinda do banco não muda os bytes assinados', async () => {
    const forward = source(twoObservations())
    const backward = source([...twoObservations()].reverse())
    const a = await buildCredential(forward, { issuer, signer })
    const b = await buildCredential(backward, { issuer, signer })
    expect(canonicalAssertion(b.payload)).toBe(canonicalAssertion(a.payload))
    expect(b.proof.signature).toBe(a.proof.signature)
  })

  it('preserva evidence_sha256 sem depender de evidence_id', async () => {
    const credential = await emit()
    const linked = credential.payload.evidence.observations.find(
      (o) => o.id === '00000000-0000-4000-8000-000000000002',
    )
    expect(linked?.evidence_sha256).toBe(Buffer.alloc(32, 9).toString('hex'))
    expect(JSON.stringify(credential)).not.toContain('evidence_id')
  })

  it('recusa emitir quando o resultado não está final ou faltam bindings', async () => {
    await expect(
      buildCredential(source(twoObservations(), { verdict: null }), { issuer, signer }),
    ).rejects.toThrow(/incomplete/)

    await expect(
      buildCredential(source(twoObservations(), { evidenceSetHash: null }), { issuer, signer }),
    ).rejects.toThrow(/bindings/)

    await expect(
      buildCredential(source(twoObservations(), { evidenceSetHash: 'f'.repeat(64) }), {
        issuer,
        signer,
      }),
    ).rejects.toThrow(/mismatch/)
  })
})

describe('adulteração', () => {
  const valid = async (): Promise<Credential> => transport(await emit())

  const expectInvalid = async (mutate: (credential: Credential) => void): Promise<void> => {
    const credential = await valid()
    mutate(credential)
    expect(verifyCredential(credential, { publicKey: keyPair.publicKey }).valid).toBe(false)
  }

  it('detecta alteração em issuer, subject, claim e target', async () => {
    await expectInvalid((c) => {
      c.payload.issuer.id = 'comprova:issuer:99999999-9999-4999-8999-999999999999'
    })
    await expectInvalid((c) => {
      c.payload.subject.id = 'sha256:' + 'f'.repeat(64)
    })
    await expectInvalid((c) => {
      c.payload.claim.type = 'address_exists'
    })
    await expectInvalid((c) => {
      c.payload.claim.target.id = '99999999-9999-4999-8999-999999999999'
    })
    await expectInvalid((c) => {
      c.payload.claim.target.building_key = 'b64:BBBB'
    })
  })

  it('detecta alteração no resultado', async () => {
    await expectInvalid((c) => {
      c.payload.result.verdict = 'NOT_FOUND'
    })
    await expectInvalid((c) => {
      c.payload.result.score = 0.1
    })
    await expectInvalid((c) => {
      c.payload.result.confidence = 0.1
    })
    await expectInvalid((c) => {
      c.payload.result.explanation = null
    })
  })

  it('detecta alteração nos bindings de policy e algoritmo', async () => {
    await expectInvalid((c) => {
      c.payload.policy.hash = 'a'.repeat(64)
    })
    await expectInvalid((c) => {
      c.payload.policy.version = '2026.99.9'
    })
    await expectInvalid((c) => {
      c.payload.algorithm.scorer_version = '2'
    })
    await expectInvalid((c) => {
      c.payload.evidence.set_hash = 'b'.repeat(64)
    })
  })

  it('detecta alteração nos timestamps, no digest de evidência e em detalhe', async () => {
    await expectInvalid((c) => {
      c.payload.timestamps.created_at = '2000-01-01T00:00:00.000Z'
    })
    await expectInvalid((c) => {
      c.payload.evidence.observations[0]!.evidence_sha256 = 'a'.repeat(64)
    })
    await expectInvalid((c) => {
      c.payload.evidence.observations[0]!.detail = { nested: { a: 1, b: 3 } }
    })
    await expectInvalid((c) => {
      c.proof.signature = c.proof.signature.slice(0, -1) + (c.proof.signature.at(-1) === 'A' ? 'B' : 'A')
    })
  })

  it('classifica falhas estruturais e de expectativa de issuer/chave', async () => {
    expect(verifyCredential({}, { publicKey: keyPair.publicKey })).toEqual({
      valid: false,
      reason: 'MALFORMED_CREDENTIAL',
    })

    const credential = await valid()
    expect(verifyCredential(credential, { publicKey: keyPair.publicKey, expectedIssuerId: 'x' })).toEqual({
      valid: false,
      reason: 'ISSUER_MISMATCH',
    })
    expect(verifyCredential(credential, { publicKey: keyPair.publicKey, expectedKeyId: 'other' })).toEqual({
      valid: false,
      reason: 'KEY_ID_MISMATCH',
    })

    const otherKey = generateEd25519KeyPair()
    expect(verifyCredential(credential, { publicKey: otherKey.publicKey })).toEqual({
      valid: false,
      reason: 'INVALID_SIGNATURE',
    })
  })
})
