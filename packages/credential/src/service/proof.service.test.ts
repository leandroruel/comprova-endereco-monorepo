import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as ed25519Sign,
  type KeyObject,
} from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createDataIntegrityProof, verifyDataIntegrityProof } from './proof.service.js'
import { canonicalize, decodeMultibaseBase58Btc, encodeMultibaseBase58Btc } from './encoding.service.js'
import { generateEd25519KeyPair, makeEd25519Signer } from './signer.service.js'

/**
 * Vetor normativo B.3 de W3C Data Integrity EdDSA Cryptosuites v1.0
 * (Representation: eddsa-jcs-2022). Se a implementação reproduz
 * canonicalização, hashing, assinatura e Multibase deste vetor, ela é
 * interoperável com o restante do ecossistema.
 */
const PUBLIC_KEY_MULTIBASE = 'z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2'
const SECRET_KEY_MULTIBASE = 'z3u2en7t5LR2WtQH5PfFqMqwVHBeXouLzo6haApm8XHqvjxq'
const VERIFICATION_METHOD = `did:key:${PUBLIC_KEY_MULTIBASE}#${PUBLIC_KEY_MULTIBASE}`
const PROOF_VALUE =
  'z2HnFSSPPBzR36zdDgK8PbEHeXbR56YF24jwMpt3R1eHXQzJDMWS93FCzpvJpwTWd3GAVFuUfjoJdcnTMuVor51aX'
const DOCUMENT_HASH = '59b7cb6251b8991add1ce0bc83107e3db9dbbab5bd2c28f687db1a03abc92f19'
const PROOF_HASH = '66ab154f5c2890a140cb8388a22a160454f80575f6eae09e5a097cabe539a1db'

const CANONICAL_DOCUMENT =
  '{"@context":["https://www.w3.org/ns/credentials/v2","https://www.w3.org/ns/credentials/examples/v2"],"credentialSubject":{"alumniOf":"The School of Examples","id":"did:example:abcdefgh"},"description":"A minimum viable example of an Alumni Credential.","id":"urn:uuid:58172aac-d8ba-11ed-83dd-0b3aef56cc33","issuer":"https://vc.example/issuers/5678","name":"Alumni Credential","type":["VerifiableCredential","AlumniCredential"],"validFrom":"2023-01-01T00:00:00Z"}'

const CANONICAL_PROOF_OPTIONS =
  '{"@context":["https://www.w3.org/ns/credentials/v2","https://www.w3.org/ns/credentials/examples/v2"],"created":"2023-02-24T23:36:38Z","cryptosuite":"eddsa-jcs-2022","proofPurpose":"assertionMethod","type":"DataIntegrityProof","verificationMethod":"did:key:z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2#z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2"}'

const document = {
  '@context': ['https://www.w3.org/ns/credentials/v2', 'https://www.w3.org/ns/credentials/examples/v2'],
  id: 'urn:uuid:58172aac-d8ba-11ed-83dd-0b3aef56cc33',
  type: ['VerifiableCredential', 'AlumniCredential'],
  name: 'Alumni Credential',
  description: 'A minimum viable example of an Alumni Credential.',
  issuer: 'https://vc.example/issuers/5678',
  validFrom: '2023-01-01T00:00:00Z',
  credentialSubject: { id: 'did:example:abcdefgh', alumniOf: 'The School of Examples' },
}

const proofOptions = {
  type: 'DataIntegrityProof',
  cryptosuite: 'eddsa-jcs-2022',
  created: '2023-02-24T23:36:38Z',
  verificationMethod: VERIFICATION_METHOD,
  proofPurpose: 'assertionMethod',
  '@context': document['@context'],
}

const securedDocument = () => ({ ...document, proof: { ...proofOptions, proofValue: PROOF_VALUE } })

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

// Ed25519 PKCS#8 (RFC 8410) e SPKI: prefixos DER usados pelo `node:crypto`.
const privateKeyFromSeed = (seed: Uint8Array): KeyObject =>
  createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  })

const publicKeyFromRaw = (raw: Uint8Array): KeyObject =>
  createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
    format: 'der',
    type: 'spki',
  })

const vectorSecretSeed = (): Uint8Array => decodeMultibaseBase58Btc(SECRET_KEY_MULTIBASE).subarray(2)
const vectorPublicKey = (): KeyObject =>
  publicKeyFromRaw(decodeMultibaseBase58Btc(PUBLIC_KEY_MULTIBASE).subarray(2))

describe('data integrity proof (eddsa-jcs-2022)', () => {
  it('reproduz a canonicalização e o hashing do vetor normativo B.3', () => {
    expect(canonicalize(document)).toBe(CANONICAL_DOCUMENT)
    expect(canonicalize(proofOptions)).toBe(CANONICAL_PROOF_OPTIONS)
    expect(sha256(CANONICAL_DOCUMENT)).toBe(DOCUMENT_HASH)
    expect(sha256(CANONICAL_PROOF_OPTIONS)).toBe(PROOF_HASH)
  })

  it('cria o mesmo `proofValue` do vetor normativo B.3', async () => {
    const proof = await createDataIntegrityProof(document, {
      verificationMethod: VERIFICATION_METHOD,
      proofPurpose: 'assertionMethod',
      created: '2023-02-24T23:36:38Z',
      signer: makeEd25519Signer(privateKeyFromSeed(vectorSecretSeed())),
    })

    expect(proof.proofValue).toBe(PROOF_VALUE)
    expect(proof['@context']).toEqual(document['@context'])
  })

  it('verifica o documento securizado do vetor normativo B.3', () => {
    expect(verifyDataIntegrityProof(securedDocument(), { publicKey: vectorPublicKey() })).toEqual({
      valid: true,
    })
  })

  it('faz round-trip com um par de chaves gerado', async () => {
    const keyPair = generateEd25519KeyPair()
    const proof = await createDataIntegrityProof(document, {
      verificationMethod: VERIFICATION_METHOD,
      proofPurpose: 'assertionMethod',
      created: '2026-01-01T00:00:00.000Z',
      signer: makeEd25519Signer(keyPair.privateKey),
    })

    expect(verifyDataIntegrityProof({ ...document, proof }, { publicKey: keyPair.publicKey })).toEqual({
      valid: true,
    })
    expect(verifyDataIntegrityProof({ ...document, proof }, { publicKey: vectorPublicKey() })).toEqual({
      valid: false,
      reason: 'INVALID_SIGNATURE',
    })
  })

  it('detecta adulteração do documento e do proofValue', () => {
    const tamperedDocument = {
      ...securedDocument(),
      name: 'Alumni Credential (tampered)',
    }
    expect(verifyDataIntegrityProof(tamperedDocument, { publicKey: vectorPublicKey() })).toEqual({
      valid: false,
      reason: 'INVALID_SIGNATURE',
    })

    const tamperedProof = securedDocument()
    tamperedProof.proof.proofValue = `${PROOF_VALUE.slice(0, -1)}A`
    expect(verifyDataIntegrityProof(tamperedProof, { publicKey: vectorPublicKey() })).toEqual({
      valid: false,
      reason: 'INVALID_SIGNATURE',
    })

    const badMultibase = securedDocument()
    badMultibase.proof.proofValue =
      '2HnFSSPPBzR36zdDgK8PbEHeXbR56YF24jwMpt3R1eHXQzJDMWS93FCzpvJpwTWd3GAVFuUfjoJdcnTMuVor51aX'
    expect(verifyDataIntegrityProof(badMultibase, { publicKey: vectorPublicKey() })).toEqual({
      valid: false,
      reason: 'INVALID_PROOF_VALUE',
    })
  })

  it('rejeita cryptosuite não suportada, proof malformado e @context divergente', () => {
    const unsupported = securedDocument()
    unsupported.proof.cryptosuite = 'ecdsa-jcs-2019'
    expect(verifyDataIntegrityProof(unsupported, { publicKey: vectorPublicKey() })).toEqual({
      valid: false,
      reason: 'UNSUPPORTED_CRYPTOSUITE',
    })

    expect(verifyDataIntegrityProof({ ...document }, { publicKey: vectorPublicKey() })).toEqual({
      valid: false,
      reason: 'MALFORMED_PROOF',
    })
    expect(
      verifyDataIntegrityProof(
        { ...document, proof: { proofPurpose: 'assertionMethod' } },
        {
          publicKey: vectorPublicKey(),
        },
      ),
    ).toEqual({ valid: false, reason: 'MALFORMED_PROOF' })

    const divergentContext = securedDocument()
    divergentContext['@context'] = ['https://www.w3.org/ns/credentials/v2']
    expect(verifyDataIntegrityProof(divergentContext, { publicKey: vectorPublicKey() })).toEqual({
      valid: false,
      reason: 'PROOF_CONTEXT_MISMATCH',
    })
  })

  it('verifica provas com propriedades assinadas adicionais (expires, domain, challenge, nonce)', () => {
    const keyPair = generateEd25519KeyPair()
    const options = {
      ...proofOptions,
      expires: '2027-01-01T00:00:00Z',
      domain: 'example.org',
      challenge: 'challenge-1',
      nonce: 'nonce-1',
    }

    // A Data Integrity permite propriedades extras no proof; elas fazem parte do
    // proofConfig assinado e não podem ser descartadas pelo verificador.
    const hashData = Buffer.concat([
      createHash('sha256').update(canonicalize(options), 'utf8').digest(),
      createHash('sha256').update(canonicalize(document), 'utf8').digest(),
    ])
    const proofValue = encodeMultibaseBase58Btc(ed25519Sign(null, hashData, keyPair.privateKey))
    const secured = { ...document, proof: { ...options, proofValue } }

    expect(verifyDataIntegrityProof(secured, { publicKey: keyPair.publicKey })).toEqual({ valid: true })

    const tampered = { ...secured, proof: { ...secured.proof, domain: 'other.example' } }
    expect(verifyDataIntegrityProof(tampered, { publicKey: keyPair.publicKey })).toEqual({
      valid: false,
      reason: 'INVALID_SIGNATURE',
    })
  })

  it('aplica `expectedProofPurpose`, quando fornecido', () => {
    expect(
      verifyDataIntegrityProof(securedDocument(), {
        publicKey: vectorPublicKey(),
        expectedProofPurpose: 'authentication',
      }),
    ).toEqual({ valid: false, reason: 'PROOF_PURPOSE_MISMATCH' })

    expect(
      verifyDataIntegrityProof(securedDocument(), {
        publicKey: vectorPublicKey(),
        expectedProofPurpose: 'assertionMethod',
      }),
    ).toEqual({ valid: true })
  })
})
