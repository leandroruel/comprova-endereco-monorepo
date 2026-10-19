import { evidenceSetHashOfObservations } from '@comprova/core'
import { describe, expect, it } from 'vitest'
import type { AssertionObservation, AssertionSource } from './assertion.js'
import { buildCredential } from './credential.js'
import { issuerIdOf, localIssuer, verificationMethodOf } from './issuer.js'
import { issuerKeyDocumentOf, type IssuerKeyDocument } from './issuer-key.js'
import { decodeEd25519PublicKeyMultibase, encodeEd25519PublicKeyMultibase } from './public-key.js'
import {
  makeHttpIssuerResolver,
  verifyCredentialFromIssuer,
  type VerificationMethodResolver,
} from './resolver.js'
import { generateEd25519KeyPair, makeEd25519Signer } from './signer.js'
import type { SecuredVerifiableCredential } from './vc.js'

const ISSUER_ORIGIN = 'https://issuer.test'
const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222'

const PROOF_CREATED_AT = new Date('2026-02-01T00:00:00.000Z')

const observation = (id: string): AssertionObservation => ({
  id,
  checker: 'registry_match',
  checkerVersion: '1',
  stance: 'supports',
  strength: 0.9,
  confidence: 0.8,
  source: 'receita',
  observedAt: new Date('2026-01-02T03:04:05.000Z'),
  evidenceSha256: null,
  detail: { nested: { b: 2, a: 1 } },
})

const observations = (): AssertionObservation[] => [
  observation('00000000-0000-4000-8000-000000000001'),
  observation('00000000-0000-4000-8000-000000000002'),
]

const source = (): AssertionSource => ({
  tenantId: TENANT,
  validation: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    verdict: 'CONFIRMED_COMMERCIAL',
    score: 0.9,
    confidence: 0.8,
    policyVersion: '2026.13.1',
    policyHash: 'd'.repeat(64),
    scorerVersion: '1',
    evidenceSetHash: evidenceSetHashOfObservations(observations()),
    legalBasis: 'FRAUD_PREVENTION',
    issuerScopes: ['validate:write'],
    explanation: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    completedAt: new Date('2026-01-01T00:00:01.000Z'),
    expiresAt: new Date('2026-01-31T00:00:00.000Z'),
  },
  subject: { docType: 'CNPJ', docHmac: Buffer.alloc(32, 7) },
  claim: {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    type: 'business_registered_address',
    subjectType: 'organization',
    targetType: 'address',
    addressId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  },
  addressBuildingKey: 'b64:AAAA',
  observations: observations(),
})

const keyPair = generateEd25519KeyPair()
const signer = makeEd25519Signer(keyPair.privateKey)
const issuer = localIssuer(ISSUER_ORIGIN, TENANT, 'key-1')

const emit = async (): Promise<SecuredVerifiableCredential> =>
  JSON.parse(
    JSON.stringify(await buildCredential(source(), { issuer, signer, now: () => PROOF_CREATED_AT })),
  ) as SecuredVerifiableCredential

/** Resolver que devolve o método confiável sem rede. */
const staticResolver =
  (document: IssuerKeyDocument): VerificationMethodResolver =>
  async (verificationMethod) => {
    const method = document.verificationMethod.find((entry) => entry.id === verificationMethod)
    if (method === undefined) throw new Error('not found')
    return { id: method.id, publicKey: decodeEd25519PublicKeyMultibase(method.publicKeyMultibase) }
  }

const document = issuerKeyDocumentOf(issuer, keyPair.publicKey)

describe('publicKeyMultibase', () => {
  it('faz round-trip da chave pública Ed25519 e liga a chave ao KeyObject', () => {
    const value = encodeEd25519PublicKeyMultibase(keyPair.publicKey)
    expect(value).toMatch(/^z[1-9A-HJ-NP-Za-km-z]+$/)
    expect(decodeEd25519PublicKeyMultibase(value).equals(keyPair.publicKey)).toBe(true)
  })
})

describe('issuerKeyDocumentOf', () => {
  it('publica só o método do issuer, com controller e chave pública', () => {
    expect(document).toEqual({
      id: issuer.id,
      verificationMethod: [
        {
          id: verificationMethodOf(issuer),
          type: 'Multikey',
          controller: issuer.id,
          publicKeyMultibase: expect.stringMatching(/^z/),
        },
      ],
    })
    const json = JSON.stringify(document)
    expect(json).not.toContain('PRIVATE')
    expect(json).not.toContain(TENANT)
  })
})

describe('verifyCredentialFromIssuer', () => {
  it('resolve a chave do issuer e valida a credencial', async () => {
    const credential = await emit()
    expect(
      await verifyCredentialFromIssuer(credential, staticResolver(document), {
        expectedIssuerId: issuer.id,
      }),
    ).toEqual({ valid: true })
  })

  it('rejeita adulteração da carga mantendo a assinatura', async () => {
    const credential = await emit()
    credential['comprova:result']['comprova:verdict'] = 'NOT_FOUND'
    expect(await verifyCredentialFromIssuer(credential, staticResolver(document))).toEqual({
      valid: false,
      reason: 'INVALID_SIGNATURE',
    })
  })

  it('classifica chave errada como INVALID_SIGNATURE', async () => {
    const credential = await emit()
    const otherKeyPair = generateEd25519KeyPair()
    const resolver: VerificationMethodResolver = async (verificationMethod) => ({
      id: verificationMethod,
      publicKey: otherKeyPair.publicKey,
    })
    expect(await verifyCredentialFromIssuer(credential, resolver)).toEqual({
      valid: false,
      reason: 'INVALID_SIGNATURE',
    })
  })

  it('classifica método inexistente como VERIFICATION_METHOD_UNRESOLVED', async () => {
    const credential = await emit()
    const emptyDocument = issuerKeyDocumentOf(localIssuer(ISSUER_ORIGIN, TENANT, 'key-2'), keyPair.publicKey)
    expect(await verifyCredentialFromIssuer(credential, staticResolver(emptyDocument))).toEqual({
      valid: false,
      reason: 'VERIFICATION_METHOD_UNRESOLVED',
    })
  })

  it('rejeita verificationMethod incompatível com o issuer ANTES de resolver', async () => {
    const credential = await emit()
    const otherIssuer = localIssuer(ISSUER_ORIGIN, OTHER_TENANT, 'key-1')
    credential.proof.verificationMethod = verificationMethodOf(otherIssuer)

    let called = false
    const resolver: VerificationMethodResolver = async (verificationMethod) => {
      called = true
      return { id: verificationMethod, publicKey: keyPair.publicKey }
    }
    expect(await verifyCredentialFromIssuer(credential, resolver)).toEqual({
      valid: false,
      reason: 'VERIFICATION_METHOD_MISMATCH',
    })
    expect(called).toBe(false)
  })

  it('rejeita malformada e issuer esperado divergente', async () => {
    expect(await verifyCredentialFromIssuer({}, staticResolver(document))).toEqual({
      valid: false,
      reason: 'MALFORMED_CREDENTIAL',
    })

    const credential = await emit()
    expect(
      await verifyCredentialFromIssuer(credential, staticResolver(document), {
        expectedIssuerId: issuerIdOf(ISSUER_ORIGIN, OTHER_TENANT),
      }),
    ).toEqual({ valid: false, reason: 'ISSUER_MISMATCH' })
  })
})

describe('makeHttpIssuerResolver', () => {
  const response = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const resolverWith = (handler: (url: string) => Response | Promise<Response>): VerificationMethodResolver =>
    makeHttpIssuerResolver({
      trustedIssuerOrigins: [ISSUER_ORIGIN],
      fetch: (async (input: string | URL | Request) =>
        handler(input instanceof Request ? input.url : input.toString())) as typeof fetch,
    })

  it('busca o documento do issuer e devolve a chave do método', async () => {
    const resolver = resolverWith((url) => {
      expect(url).toBe(issuer.id)
      return response(document)
    })
    const credential = await emit()
    expect(await verifyCredentialFromIssuer(credential, resolver)).toEqual({ valid: true })
  })

  it('não busca origem fora da allowlist', async () => {
    let called = false
    const resolver = resolverWith(() => {
      called = true
      return response(document)
    })
    await expect(resolver(`${issuerIdOf('https://evil.test', TENANT)}#key-1`)).rejects.toThrow(/not trusted/)
    expect(called).toBe(false)
  })

  it('recusa método ausente, issuer divergente, HTTP não-ok e documento malformado', async () => {
    await expect(resolverWith(() => response(document))(`${issuer.id}#outra`)).rejects.toThrow(/not found/)
    await expect(
      resolverWith(() => response({ ...document, id: `${ISSUER_ORIGIN}/issuers/${'a'.repeat(43)}` }))(
        verificationMethodOf(issuer),
      ),
    ).rejects.toThrow(/id does not match/)
    await expect(resolverWith(() => response({}, 500))(verificationMethodOf(issuer))).rejects.toThrow(
      /status 500/,
    )
    await expect(resolverWith(() => response({ nope: true }))(verificationMethodOf(issuer))).rejects.toThrow(
      /malformed/,
    )
  })

  it('recusa method não-https e host sem allowlist', async () => {
    const resolver = resolverWith(() => response(document))
    await expect(resolver(`http://issuer.test/issuers/${'a'.repeat(43)}#key-1`)).rejects.toThrow(/https/)
  })
})
