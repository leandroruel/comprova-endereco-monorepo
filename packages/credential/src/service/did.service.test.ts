import { evidenceSetHashOfObservations } from '@comprova/core'
import { describe, expect, it } from 'vitest'
import type { AssertionObservation, AssertionSource } from '../schema/assertion.schema.js'
import type { SecuredVerifiableCredential } from '../schema/credential.schema.js'
import { DID_CONTEXT_URL } from '../schema/did.schema.js'
import { buildCredential } from './credential.service.js'
import {
  didDocumentOf,
  didDocumentUrlOf,
  didOfIssuer,
  didVerificationMethodOf,
  makeHttpDidResolver,
} from './did.service.js'
import { issuerIdOf, issuerScopeOf, localIssuer, verificationMethodOf } from './issuer.service.js'
import { generateEd25519KeyPair, makeEd25519Signer } from './signer.service.js'
import {
  verifyCredential,
  verifyCredentialFromIssuer,
  type VerificationMethodResolver,
} from './verification.service.js'

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
const otherKeyPair = generateEd25519KeyPair()
const signer = makeEd25519Signer(keyPair.privateKey)
const issuer = localIssuer(ISSUER_ORIGIN, TENANT, 'key-1')
const otherIssuer = localIssuer(ISSUER_ORIGIN, OTHER_TENANT, 'key-1')

const did = didOfIssuer(issuer.id)
const otherDid = didOfIssuer(otherIssuer.id)
const document = didDocumentOf(did, issuer.id, [{ keyId: issuer.keyId, publicKey: keyPair.publicKey }])
const otherDocument = didDocumentOf(otherDid, otherIssuer.id, [
  { keyId: otherIssuer.keyId, publicKey: otherKeyPair.publicKey },
])

const emit = async (): Promise<SecuredVerifiableCredential> =>
  JSON.parse(
    JSON.stringify(await buildCredential(source(), { issuer, signer, now: () => PROOF_CREATED_AT })),
  ) as SecuredVerifiableCredential

const activeStatus = async (): Promise<'ACTIVE'> => 'ACTIVE'

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const resolverWith = (
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  trustedIssuerOrigins: readonly string[] = [ISSUER_ORIGIN],
): VerificationMethodResolver =>
  makeHttpDidResolver({
    trustedIssuerOrigins,
    fetch: (async (input: string | URL | Request, init?: RequestInit) =>
      handler(input instanceof Request ? input.url : input.toString(), init)) as typeof fetch,
  })

describe('didOfIssuer', () => {
  it('é determinístico, por tenant, e não expõe dados internos', () => {
    expect(didOfIssuer(issuer.id)).toBe(didOfIssuer(issuerIdOf(ISSUER_ORIGIN, TENANT)))
    expect(did).toMatch(/^did:web:issuer\.test:issuers:[A-Za-z0-9_-]{43}$/)
    expect(did).toBe(`did:web:issuer.test:issuers:${issuerScopeOf(TENANT)}`)
    expect(did).not.toContain(TENANT)
    expect(did).not.toContain(source().validation.id)
    expect(did).not.toContain('doc_hmac')
    expect(did).not.toContain('CPF')
    expect(did).not.toContain('CNPJ')
  })

  it('isola tenants e origens', () => {
    expect(did).not.toBe(otherDid)
    expect(didOfIssuer(issuer.id)).not.toBe(didOfIssuer(issuerIdOf('https://outro.test', TENANT)))
  })

  it('percent-encoda a porta do host, como o método did:web exige', () => {
    const scope = issuerScopeOf(TENANT)
    expect(didOfIssuer(`https://issuer.test:8443/issuers/${scope}`)).toBe(
      `did:web:issuer.test%3A8443:issuers:${scope}`,
    )
    expect(didDocumentUrlOf(`did:web:issuer.test%3A8443:issuers:${scope}`)).toBe(
      `https://issuer.test:8443/issuers/${scope}/did.json`,
    )
  })

  it('recusa o que não é um issuer do Comprova', () => {
    expect(() => didOfIssuer('http://issuer.test/issuers/a')).toThrow(/https/)
    expect(() => didOfIssuer(`${ISSUER_ORIGIN}/outro/${'a'.repeat(43)}`)).toThrow(/no Comprova issuer/)
    expect(() => didOfIssuer(`${ISSUER_ORIGIN}/issuers/${'a'.repeat(42)}`)).toThrow(/no Comprova issuer/)
    expect(() => didOfIssuer(`${ISSUER_ORIGIN}/issuers/a%3Fb`)).toThrow(/no Comprova issuer/)
    expect(() => didOfIssuer(`${issuer.id}?x=1`)).toThrow(/query or fragment/)
    expect(() => didOfIssuer(`${issuer.id}#key-1`)).toThrow(/query or fragment/)
    expect(() => didOfIssuer('not-a-url')).toThrow(/not a URL/)
  })
})

describe('didDocumentUrlOf (resolução did:web)', () => {
  it('mapeia o DID do issuer para <issuer.id>/did.json', () => {
    expect(didDocumentUrlOf(did)).toBe(`${issuer.id}/did.json`)
    // O fragmento identifica um método, não o documento.
    expect(didDocumentUrlOf(`${did}#key-1`)).toBe(`${issuer.id}/did.json`)
  })

  it('mapeia o host raiz para o caminho bem-conhecido de did:web', () => {
    expect(didDocumentUrlOf('did:web:issuer.test')).toBe('https://issuer.test/.well-known/did.json')
  })

  it('recusa identificadores que não resolvem por did:web', () => {
    expect(() => didDocumentUrlOf('did:key:z6Mk')).toThrow(/not a did:web/)
    expect(() => didDocumentUrlOf('did:web:')).toThrow(/no host/)
    expect(() => didDocumentUrlOf('did:web:issuer.test:issuers:..')).toThrow(/not safe/)
    expect(() => didDocumentUrlOf('did:web:..')).toThrow(/not a valid domain/)
    expect(() => didDocumentUrlOf('did:web:issuer.test:issuers:a%2Fb')).toThrow(/not safe/)
    expect(() => didDocumentUrlOf('did:web:issuer.test:issuers:%ZZ')).toThrow(/percent-encoded/)
  })

  it('re-encoda segmentos decodificados para não criar query ou fragmento', () => {
    // Sem o re-encode, `%3F` viraria `?` e o fetch apontaria outro recurso.
    expect(didDocumentUrlOf('did:web:issuer.test:issuers:a%3Fb')).toBe(
      'https://issuer.test/issuers/a%3Fb/did.json',
    )
    expect(didDocumentUrlOf('did:web:issuer.test:issuers:a%23b')).toBe(
      'https://issuer.test/issuers/a%23b/did.json',
    )
    // `%` literal também é re-encodado, sem dupla decodificação.
    expect(didDocumentUrlOf('did:web:issuer.test:issuers:a%2520b')).toBe(
      'https://issuer.test/issuers/a%2520b/did.json',
    )
  })
})

describe('didDocumentOf', () => {
  it('publica a identidade, o vínculo com o issuer e o método de assertion', () => {
    expect(document).toEqual({
      '@context': [DID_CONTEXT_URL],
      id: did,
      alsoKnownAs: [issuer.id],
      verificationMethod: [
        {
          id: didVerificationMethodOf(did, issuer.keyId),
          type: 'Multikey',
          controller: did,
          publicKeyMultibase: expect.stringMatching(/^z/),
        },
      ],
      assertionMethod: [didVerificationMethodOf(did, issuer.keyId)],
    })
    const json = JSON.stringify(document)
    expect(json).not.toContain('PRIVATE')
    expect(json).not.toContain(TENANT)
    expect(json).not.toContain('doc_hmac')
  })

  it('lista todas as chaves publicadas (rotação) no documento daquele issuer', () => {
    const rotated = didDocumentOf(did, issuer.id, [
      { keyId: 'key-1', publicKey: keyPair.publicKey },
      { keyId: 'key-2', publicKey: otherKeyPair.publicKey },
    ])
    expect(rotated.verificationMethod.map((method) => method.id)).toEqual([
      didVerificationMethodOf(did, 'key-1'),
      didVerificationMethodOf(did, 'key-2'),
    ])
    expect(rotated.assertionMethod).toEqual(rotated.verificationMethod.map((method) => method.id))
  })
})

describe('makeHttpDidResolver', () => {
  it('resolve o DID Document e verifica a credencial ponta a ponta', async () => {
    const requested: string[] = []
    const resolver = resolverWith((url) => {
      requested.push(url)
      return response(document)
    })

    const credential = await emit()
    expect(await verifyCredentialFromIssuer(credential, resolver, { statusResolver: activeStatus })).toEqual({
      valid: true,
    })
    expect(requested).toEqual([`${issuer.id}/did.json`])
  })

  it('não busca origem fora da allowlist nem com http', async () => {
    let called = false
    const resolver = resolverWith(() => {
      called = true
      return response(document)
    })

    await expect(resolver(`${issuerIdOf('https://evil.test', TENANT)}#key-1`)).rejects.toThrow(/not trusted/)
    await expect(resolver(verificationMethodOf(issuer).replace('https:', 'http:'))).rejects.toThrow(/https/)
    await expect(resolver(`${issuer.id}?x=1`)).rejects.toThrow(/query/)
    await expect(resolver(`${issuer.id}#key-1?x=1`)).rejects.toThrow(/fragment/)
    expect(called).toBe(false)
  })

  it('recusa escopo fora do formato do issuer antes de buscar', async () => {
    let called = false
    const resolver = resolverWith(() => {
      called = true
      return response(document)
    })

    await expect(resolver(`${ISSUER_ORIGIN}/issuers/a%3Fb#key-1`)).rejects.toThrow(/no Comprova issuer/)
    await expect(resolver(`${ISSUER_ORIGIN}/issuers/curto#key-1`)).rejects.toThrow(/no Comprova issuer/)
    expect(called).toBe(false)
  })

  it('recusa documento adulterado: id, alsoKnownAs, assertionMethod, controller e chave', async () => {
    const vm = verificationMethodOf(issuer)

    await expect(resolverWith(() => response({ ...document, id: otherDid }))(vm)).rejects.toThrow(
      /id does not match/,
    )
    await expect(
      resolverWith(() => response({ ...document, alsoKnownAs: [otherIssuer.id] }))(vm),
    ).rejects.toThrow(/does not acknowledge/)
    await expect(
      resolverWith(() => response({ ...document, assertionMethod: [`${otherDid}#key-1`] }))(vm),
    ).rejects.toThrow(/does not authorize/)
    await expect(
      resolverWith(() =>
        response({
          ...document,
          verificationMethod: [{ ...document.verificationMethod[0]!, controller: otherDid }],
        }),
      )(vm),
    ).rejects.toThrow(/controller is not the issuer DID/)
    await expect(resolverWith(() => response({ ...document, '@context': ['x'] }))(vm)).rejects.toThrow(
      /DID context/,
    )
    expect(await resolverWith(() => response(document))(vm)).toMatchObject({ id: vm })

    // Método desconhecido dentro do documento do próprio issuer: não autorizado.
    await expect(resolverWith(() => response(document))(`${issuer.id}#key-9`)).rejects.toThrow(
      /does not authorize/,
    )
    // Autorizado em `assertionMethod` mas ausente de `verificationMethod`.
    await expect(
      resolverWith(() => response({ ...document, assertionMethod: [didVerificationMethodOf(did, 'key-9')] }))(
        verificationMethodOf(issuer).replace('key-1', 'key-9'),
      ),
    ).rejects.toThrow(/not found/)
    // Fragmento ausente.
    await expect(resolverWith(() => response(document))(issuer.id)).rejects.toThrow(/no key fragment/)
    // Resposta inválida / HTTP não-ok / redirect.
    await expect(resolverWith(() => new Response('not json', { status: 200 }))(vm)).rejects.toThrow(
      /malformed/,
    )
    await expect(resolverWith(() => response({}, 500))(vm)).rejects.toThrow(/status 500/)
    const redirected = (): Response =>
      ({ ok: true, status: 200, redirected: true, json: async () => document }) as Response
    await expect(resolverWith(() => redirected())(vm)).rejects.toThrow(/redirect/)
  })

  it('documento com chave diferente não verifica a credencial (INVALID_SIGNATURE)', async () => {
    const tampered = didDocumentOf(did, issuer.id, [
      { keyId: issuer.keyId, publicKey: otherKeyPair.publicKey },
    ])
    const resolver = resolverWith(() => response(tampered))
    const credential = await emit()

    expect(await verifyCredentialFromIssuer(credential, resolver, { statusResolver: activeStatus })).toEqual({
      valid: false,
      reason: 'INVALID_SIGNATURE',
    })
  })

  it('não aceita o método de um issuer no documento de outro', async () => {
    let fetched = false
    const resolver = resolverWith(() => {
      fetched = true
      return response(otherDocument)
    })
    const credential = await emit()
    const otherCredential = await buildCredential(source(), {
      issuer: otherIssuer,
      signer: makeEd25519Signer(otherKeyPair.privateKey),
      now: () => PROOF_CREATED_AT,
    })

    // O método de B não pertence ao issuer A: recusa ANTES de buscar.
    const tampered = JSON.parse(JSON.stringify(credential)) as SecuredVerifiableCredential
    tampered.proof.verificationMethod = otherCredential.proof.verificationMethod
    expect(await verifyCredentialFromIssuer(tampered, resolver)).toEqual({
      valid: false,
      reason: 'VERIFICATION_METHOD_MISMATCH',
    })
    expect(fetched).toBe(false)

    // O documento de B (sozinho) não contém a chave (nem o escopo) do issuer A.
    expect(JSON.stringify(otherDocument)).not.toContain(issuerScopeOf(TENANT))
    expect(otherDocument.id).toBe(otherDid)
    expect(otherDocument.id).not.toBe(did)

    // Verificação independente: a chave resolvida confere com o método confiável.
    const resolved = await resolverWith(() => response(otherDocument))(verificationMethodOf(otherIssuer))
    expect(
      verifyCredential(otherCredential, { trusted: { id: resolved.id, publicKey: resolved.publicKey } }),
    ).toEqual({ valid: true })
  })

  it('issuer adulterado (verificationMethod de A com issuer de B) é recusado', async () => {
    const credential = await emit()
    const tampered = JSON.parse(JSON.stringify(credential)) as SecuredVerifiableCredential
    tampered.issuer = otherIssuer.id

    expect(
      await verifyCredentialFromIssuer(
        tampered,
        resolverWith(() => response(document)),
      ),
    ).toEqual({
      valid: false,
      reason: 'VERIFICATION_METHOD_MISMATCH',
    })
  })
})
