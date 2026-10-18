import { describe, expect, it } from 'vitest'
import { issuerIdOf } from './issuer.js'
import { deriveCredentialSubjectId, subjectDigestOf } from './subject.js'

const ORIGIN = 'https://issuer.test'
const OTHER_ORIGIN = 'https://outro.test'
const tenantA = '11111111-1111-4111-8111-111111111111'
const tenantB = '22222222-2222-4222-8222-222222222222'
const docHmac = Buffer.alloc(32, 7)

const subjectId = (tenantId: string, docType: 'CPF' | 'CNPJ', origin = ORIGIN): string =>
  deriveCredentialSubjectId({
    issuerId: issuerIdOf(origin, tenantId),
    tenantId,
    docType,
    docHmac,
  })

describe('deriveCredentialSubjectId', () => {
  it('é determinístico e tem a forma de URL HTTPS no namespace do issuer', () => {
    const id = subjectId(tenantA, 'CNPJ')

    expect(id).toBe(subjectId(tenantA, 'CNPJ'))
    expect(id).toMatch(/^https:\/\/issuer\.test\/issuers\/[A-Za-z0-9_-]{43}\/subjects\/[0-9a-f]{64}$/)
    expect(id).toBe(
      `${issuerIdOf(ORIGIN, tenantA)}/subjects/${subjectDigestOf({ tenantId: tenantA, docType: 'CNPJ', docHmac })}`,
    )
  })

  it('é escopo por issuer (não permite correlação cross-tenant)', () => {
    expect(subjectId(tenantA, 'CNPJ')).not.toBe(subjectId(tenantB, 'CNPJ'))
    expect(subjectId(tenantA, 'CNPJ')).not.toBe(subjectId(tenantA, 'CNPJ', OTHER_ORIGIN))
  })

  it('distingue o tipo de documento', () => {
    expect(subjectId(tenantA, 'CNPJ')).not.toBe(subjectId(tenantA, 'CPF'))
  })

  it('não expõe o doc_hmac nem o tenant_id', () => {
    const id = subjectId(tenantA, 'CNPJ')

    expect(id).not.toContain(docHmac.toString('hex'))
    expect(id).not.toContain(docHmac.toString('base64url'))
    expect(id).not.toContain(tenantA)
  })

  it('o digest do pseudônimo não depende do namespace do issuer', () => {
    const a = subjectId(tenantA, 'CNPJ')
    const b = subjectId(tenantA, 'CNPJ', OTHER_ORIGIN)

    expect(b.split('/subjects/')[1]).toBe(a.split('/subjects/')[1])
  })
})
