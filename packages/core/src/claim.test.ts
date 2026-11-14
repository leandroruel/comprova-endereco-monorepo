import { describe, expect, it } from 'vitest'
import { addressClaimForSubjectDocType } from './claim.js'

// ADR-0037/ADR-0045: a Claim de endereço de uma Validation é derivada do
// `subject.docType`. O comprovante do Holder só pode materializar recibo nesta
// Claim — nunca em outra finalidade da mesma Validation.
describe('addressClaimForSubjectDocType', () => {
  it('deriva business_registered_address/organization para CNPJ', () => {
    expect(addressClaimForSubjectDocType('CNPJ')).toEqual({
      type: 'business_registered_address',
      subjectType: 'organization',
    })
  })

  it('deriva address_exists/person para CPF e demais documentos', () => {
    expect(addressClaimForSubjectDocType('CPF')).toEqual({
      type: 'address_exists',
      subjectType: 'person',
    })
    expect(addressClaimForSubjectDocType('RG')).toEqual({
      type: 'address_exists',
      subjectType: 'person',
    })
    expect(addressClaimForSubjectDocType('')).toEqual({
      type: 'address_exists',
      subjectType: 'person',
    })
  })

  it('distingue CNPJ case-sensitive', () => {
    expect(addressClaimForSubjectDocType('cnpj')).toEqual({
      type: 'address_exists',
      subjectType: 'person',
    })
  })
})
