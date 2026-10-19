import { describe, expect, it } from 'vitest'
import { DID_CONTEXT_URL, DidDocumentSchema } from './did.schema.js'

const method = {
  id: 'did:web:issuer.test:issuers:abc#key-1',
  type: 'Multikey' as const,
  controller: 'did:web:issuer.test:issuers:abc',
  publicKeyMultibase: 'z6Mk',
}

const document = {
  '@context': [DID_CONTEXT_URL],
  id: 'did:web:issuer.test:issuers:abc',
  alsoKnownAs: ['https://issuer.test/issuers/abc'],
  verificationMethod: [method],
  assertionMethod: [method.id],
}

describe('DidDocumentSchema', () => {
  it('aceita um DID Document mínimo e preserva campos W3C extras', () => {
    const parsed = DidDocumentSchema.safeParse({ ...document, service: [{ id: '#x', type: 'X' }] })
    expect(parsed.success).toBe(true)
  })

  it('exige @context, id, alsoKnownAs, verificationMethod e assertionMethod', () => {
    for (const key of ['@context', 'id', 'alsoKnownAs', 'verificationMethod', 'assertionMethod'] as const) {
      expect(DidDocumentSchema.safeParse({ ...document, [key]: undefined }).success).toBe(false)
    }
  })

  it('recusa verificationMethod vazio e tipo de chave diferente de Multikey', () => {
    expect(DidDocumentSchema.safeParse({ ...document, verificationMethod: [] }).success).toBe(false)
    expect(
      DidDocumentSchema.safeParse({
        ...document,
        verificationMethod: [{ ...method, type: 'JsonWebKey2020' }],
      }).success,
    ).toBe(false)
  })
})
