import { describe, expect, it } from 'vitest'
import { deriveCredentialSubjectId } from './subject.js'

const docHmac = Buffer.alloc(32, 7)
const tenantA = '11111111-1111-1111-1111-111111111111'
const tenantB = '22222222-2222-2222-2222-222222222222'

describe('deriveCredentialSubjectId', () => {
  it('é determinístico para o mesmo tenant/documento', () => {
    const a = deriveCredentialSubjectId({ tenantId: tenantA, docType: 'CNPJ', docHmac })
    const b = deriveCredentialSubjectId({ tenantId: tenantA, docType: 'CNPJ', docHmac })
    expect(a).toBe(b)
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('é escopo por issuer (não permite correlação cross-tenant)', () => {
    const a = deriveCredentialSubjectId({ tenantId: tenantA, docType: 'CNPJ', docHmac })
    const b = deriveCredentialSubjectId({ tenantId: tenantB, docType: 'CNPJ', docHmac })
    expect(a).not.toBe(b)
  })

  it('distingue o tipo de documento', () => {
    const cnpj = deriveCredentialSubjectId({ tenantId: tenantA, docType: 'CNPJ', docHmac })
    const cpf = deriveCredentialSubjectId({ tenantId: tenantA, docType: 'CPF', docHmac })
    expect(cnpj).not.toBe(cpf)
  })

  it('não expõe o doc_hmac', () => {
    const id = deriveCredentialSubjectId({ tenantId: tenantA, docType: 'CNPJ', docHmac })
    expect(id).not.toContain(docHmac.toString('hex'))
  })
})
