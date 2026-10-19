import { evidenceSetHashOfObservations } from '@comprova/core'
import { describe, expect, it } from 'vitest'
import type { AssertionObservation, AssertionSource } from '../schema/assertion.schema.js'
import type { SecuredVerifiableCredential } from '../schema/credential.schema.js'
import type { IssuerKeyDocument } from '../schema/issuer.schema.js'
import { buildCredential } from './credential.service.js'
import {
  decodeEd25519PublicKeyMultibase,
  encodeEd25519PublicKeyMultibase,
  issuerIdOf,
  issuerKeyDocumentOf,
  localIssuer,
  verificationMethodOf,
  wellKnownIssuerUrlOf,
} from './issuer.service.js'
import {
  makeHttpIssuerResolver,
  verifyCredentialFromIssuer,
  type VerificationMethodResolver,
} from './verification.service.js'
import {
  credentialStatusUrlOf,
  makeHttpCredentialStatusResolver,
  type CredentialStatusResolver,
} from './status.service.js'
import { generateEd25519KeyPair, makeEd25519Signer } from './signer.service.js'

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

/** Resolver de status ACTIVE, sem rede. */
const activeStatus = async (): Promise<'ACTIVE'> => 'ACTIVE'

const document = issuerKeyDocumentOf(issuer.id, [{ keyId: issuer.keyId, publicKey: keyPair.publicKey }])

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
        statusResolver: activeStatus,
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
    const emptyDocument = issuerKeyDocumentOf(issuer.id, [{ keyId: 'key-2', publicKey: keyPair.publicKey }])
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

describe('verifyCredentialFromIssuer + status', () => {
  it('ACTIVE valida a credencial revogável', async () => {
    expect(
      await verifyCredentialFromIssuer(await emit(), staticResolver(document), {
        statusResolver: activeStatus,
      }),
    ).toEqual({ valid: true })
  })

  it('REVOKED recusa com STATUS_REVOKED (sem misturar com validade temporal)', async () => {
    const credential = await emit()
    // O veredito e a janela temporal não são o que muda aqui: só o status
    // público. O resultado é de status, não de expiração.
    expect(credential.validFrom).toBe('2026-01-01T00:00:01.000Z')
    expect(credential.validUntil).toBe('2026-01-31T00:00:00.000Z')

    expect(
      await verifyCredentialFromIssuer(credential, staticResolver(document), {
        statusResolver: async () => 'REVOKED',
      }),
    ).toEqual({ valid: false, reason: 'STATUS_REVOKED' })
  })

  it('falha fechado quando não há resolver de status', async () => {
    expect(await verifyCredentialFromIssuer(await emit(), staticResolver(document))).toEqual({
      valid: false,
      reason: 'STATUS_UNAVAILABLE',
    })
  })

  it('falha fechado quando o resolver lança ou devolve um valor desconhecido', async () => {
    const credential = await emit()
    expect(
      await verifyCredentialFromIssuer(credential, staticResolver(document), {
        statusResolver: async () => {
          throw new Error('network down')
        },
      }),
    ).toEqual({ valid: false, reason: 'STATUS_UNAVAILABLE' })

    expect(
      await verifyCredentialFromIssuer(credential, staticResolver(document), {
        statusResolver: (async () => 'UNKNOWN') as unknown as CredentialStatusResolver,
      }),
    ).toEqual({ valid: false, reason: 'STATUS_UNAVAILABLE' })
  })

  it('resolve o status só DEPOIS de validar a assinatura e o binding', async () => {
    const credential = await emit()
    credential['comprova:result']['comprova:verdict'] = 'NOT_FOUND'

    let calls = 0
    const result = await verifyCredentialFromIssuer(credential, staticResolver(document), {
      statusResolver: async () => {
        calls += 1
        return 'ACTIVE'
      },
    })
    expect(result).toEqual({ valid: false, reason: 'INVALID_SIGNATURE' })
    expect(calls).toBe(0)
  })

  it('não aceita uma URL de status trocada sem refazer a assinatura', async () => {
    const credential = await emit()
    credential.credentialStatus!.id = credentialStatusUrlOf(issuer.id, 'f'.repeat(43))

    let calls = 0
    expect(
      await verifyCredentialFromIssuer(credential, staticResolver(document), {
        statusResolver: async () => {
          calls += 1
          return 'ACTIVE'
        },
      }),
    ).toEqual({ valid: false, reason: 'INVALID_SIGNATURE' })
    expect(calls).toBe(0)
  })

  it('depende só de material público: método resolvido + URL assinada de status', async () => {
    const urls: string[] = []
    expect(
      await verifyCredentialFromIssuer(await emit(), staticResolver(document), {
        statusResolver: async (url) => {
          urls.push(url)
          return 'ACTIVE'
        },
      }),
    ).toEqual({ valid: true })
    expect(urls).toHaveLength(1)
    expect(urls[0]).toMatch(
      /^https:\/\/issuer\.test\/issuers\/[A-Za-z0-9_-]{43}\/credentials\/[A-Za-z0-9_-]{43}\/status$/,
    )
  })
})

describe('makeHttpCredentialStatusResolver', () => {
  const response = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const credentialId = 'a'.repeat(43)
  const statusUrl = credentialStatusUrlOf(issuer.id, credentialId)

  const resolverWith = (
    handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
    trustedIssuerOrigins: readonly string[] = [ISSUER_ORIGIN],
  ) =>
    makeHttpCredentialStatusResolver({
      trustedIssuerOrigins,
      fetch: (async (input: string | URL | Request, init?: RequestInit) =>
        handler(input instanceof Request ? input.url : input.toString(), init)) as typeof fetch,
    })

  it('busca exatamente a URL assinada e aceita ACTIVE e REVOKED', async () => {
    for (const status of ['ACTIVE', 'REVOKED'] as const) {
      let seen: string | undefined
      const resolver = resolverWith((url) => {
        seen = url
        return response({ status })
      })
      expect(await resolver(statusUrl)).toBe(status)
      expect(seen).toBe(statusUrl)
    }
  })

  it('recusa http, origem fora da allowlist, credenciais, query/fragmento e path fora do contrato', async () => {
    let called = false
    const resolver = resolverWith(() => {
      called = true
      return response({ status: 'ACTIVE' })
    })

    await expect(resolver(statusUrl.replace('https:', 'http:'))).rejects.toThrow(/https/)
    await expect(
      resolver(credentialStatusUrlOf(`${'https://evil.test'}/issuers/${'b'.repeat(43)}`, credentialId)),
    ).rejects.toThrow(/not trusted/)
    await expect(resolver(`https://user:pass@issuer.test${new URL(statusUrl).pathname}`)).rejects.toThrow(
      /credentials/,
    )
    await expect(resolver(`${statusUrl}?x=1`)).rejects.toThrow(/query or fragment/)
    await expect(resolver(`${statusUrl}#x`)).rejects.toThrow(/query or fragment/)
    await expect(
      resolver(`${ISSUER_ORIGIN}/issuers/${'b'.repeat(43)}/${credentialId}/status`),
    ).rejects.toThrow(/not an issuer status endpoint/)
    await expect(
      resolver(statusUrl.replace(`/${credentialId}/status`, `/${'a'.repeat(42)}/status`)),
    ).rejects.toThrow(/not an issuer status endpoint/)
    await expect(resolver(statusUrl.replace('/status', ''))).rejects.toThrow(/not an issuer status endpoint/)

    expect(called).toBe(false)
  })

  it('recusa HTTP não-ok, JSON inválido, status desconhecido e campos extras', async () => {
    await expect(resolverWith(() => response({}, 500))(statusUrl)).rejects.toThrow(/status 500/)
    await expect(resolverWith(() => response({ status: 'UNKNOWN' }))(statusUrl)).rejects.toThrow(/malformed/)
    await expect(resolverWith(() => response({ status: 'ACTIVE', extra: true }))(statusUrl)).rejects.toThrow(
      /malformed/,
    )
    await expect(resolverWith(() => new Response('not json', { status: 200 }))(statusUrl)).rejects.toThrow(
      /malformed/,
    )
  })

  it('recusa resposta alcançada por redirect e instrui o fetch a não seguir 3xx', async () => {
    const redirected = (body: unknown): Response =>
      ({ ok: true, status: 200, redirected: true, json: async () => body }) as Response
    await expect(resolverWith(() => redirected({ status: 'ACTIVE' }))(statusUrl)).rejects.toThrow(/redirect/)

    let init: RequestInit | undefined
    const resolver = resolverWith((_url, options) => {
      init = options
      return response({ status: 'ACTIVE' })
    })
    await resolver(statusUrl)
    expect(init).toEqual({ redirect: 'error' })
  })
})

describe('makeHttpIssuerResolver', () => {
  const response = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const resolverWith = (
    handler: (url: string) => Response | Promise<Response>,
    options: { readonly discover?: boolean } = {},
  ): VerificationMethodResolver =>
    makeHttpIssuerResolver({
      trustedIssuerOrigins: [ISSUER_ORIGIN],
      ...options,
      fetch: (async (input: string | URL | Request) =>
        handler(input instanceof Request ? input.url : input.toString())) as typeof fetch,
    })

  it('busca o documento do issuer e devolve a chave do método', async () => {
    const resolver = resolverWith((url) => {
      expect(url).toBe(issuer.id)
      return response(document)
    })
    const credential = await emit()
    expect(await verifyCredentialFromIssuer(credential, resolver, { statusResolver: activeStatus })).toEqual({
      valid: true,
    })
  })

  it('descobre o documento pelo well-known e mantém o id do issuer', async () => {
    const discoveryUrl = wellKnownIssuerUrlOf(issuer.id)
    const resolver = resolverWith(
      (url) => {
        expect(url).toBe(discoveryUrl)
        return response(document)
      },
      { discover: true },
    )
    const credential = await emit()
    expect(await verifyCredentialFromIssuer(credential, resolver, { statusResolver: activeStatus })).toEqual({
      valid: true,
    })
  })

  it('recusa descoberta cujo documento id é a URL bem-conhecida (não o issuer)', async () => {
    const discoveryUrl = wellKnownIssuerUrlOf(issuer.id)
    const resolver = resolverWith(() => response({ ...document, id: discoveryUrl }), { discover: true })
    await expect(resolver(verificationMethodOf(issuer))).rejects.toThrow(/id does not match/)
  })

  it('recusa descoberta quando a URL do issuer não tem mapeamento bem-conhecido', async () => {
    const resolver = resolverWith(() => response(document), { discover: true })
    await expect(resolver(`${ISSUER_ORIGIN}/outro/${'a'.repeat(43)}#key-1`)).rejects.toThrow(
      /no well-known discovery mapping/,
    )
  })

  it('recusa método inexistente no documento descoberto', async () => {
    const resolver = resolverWith(() => response(document), { discover: true })
    await expect(resolver(`${issuer.id}#outra`)).rejects.toThrow(/not found/)
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

  it('recusa documento alcançado por redirect e instrui o fetch a não seguir 3xx', async () => {
    // Resposta 2xx que chegou por redirecionamento: recusada mesmo sendo válida.
    const redirected = (body: unknown): Response =>
      ({ ok: true, status: 200, redirected: true, json: async () => body }) as Response
    await expect(resolverWith(() => redirected(document))(verificationMethodOf(issuer))).rejects.toThrow(
      /redirect/,
    )

    // E o fetch real é instruído a tratar 3xx como erro, para não contornar a allowlist.
    let init: RequestInit | undefined
    const resolver = makeHttpIssuerResolver({
      trustedIssuerOrigins: [ISSUER_ORIGIN],
      fetch: (async (_input: string | URL | Request, options?: RequestInit) => {
        init = options
        return response(document)
      }) as typeof fetch,
    })
    await resolver(verificationMethodOf(issuer))
    expect(init).toEqual({ redirect: 'error' })
  })
})
