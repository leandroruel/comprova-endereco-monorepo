import { describe, expect, it } from 'vitest'
import { IssuerIdentityError, issuerIdOf, localIssuer } from './issuer.service.js'
import { credentialIdOf, credentialStatusUrlOf, credentialUrlOf } from './status.service.js'

const ISSUER_ORIGIN = 'https://issuer.test'
const TENANT_A = '11111111-1111-4111-8111-111111111111'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const VALIDATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const issuerA = issuerIdOf(ISSUER_ORIGIN, TENANT_A)

describe('credentialIdOf', () => {
  it('é determinístico para o mesmo par (issuer, validation)', () => {
    const first = credentialIdOf(issuerA, VALIDATION_ID)
    const second = credentialIdOf(issuerA, VALIDATION_ID)

    expect(first).toBe(second)
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('é opaco: não contém o tenant, a validation nem a chave', () => {
    const credentialId = credentialIdOf(issuerA, VALIDATION_ID)

    expect(credentialId).not.toContain(TENANT_A)
    expect(credentialId).not.toContain(VALIDATION_ID)
    expect(credentialId).not.toContain('key-1')
  })

  it('não correlaciona tenants: o mesmo validation_id em tenants distintos gera ids distintos', () => {
    const a = credentialIdOf(issuerIdOf(ISSUER_ORIGIN, TENANT_A), VALIDATION_ID)
    const b = credentialIdOf(issuerIdOf(ISSUER_ORIGIN, TENANT_B), VALIDATION_ID)

    expect(a).not.toBe(b)
  })

  it('não correlaciona credenciais: validations distintas geram ids distintos', () => {
    const a = credentialIdOf(issuerA, VALIDATION_ID)
    const b = credentialIdOf(issuerA, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')

    expect(a).not.toBe(b)
  })

  it('é independente da chave de assinatura (o id do issuer não carrega o key_id)', () => {
    const withKeyOne = localIssuer(ISSUER_ORIGIN, TENANT_A, 'key-1')
    const withKeyTwo = localIssuer(ISSUER_ORIGIN, TENANT_A, 'key-2')

    expect(withKeyOne.id).toBe(withKeyTwo.id)
    expect(credentialIdOf(withKeyOne.id, VALIDATION_ID)).toBe(credentialIdOf(withKeyTwo.id, VALIDATION_ID))
  })

  it('recusa um issuer que não seja uma URL https sem query/fragmento', () => {
    expect(() => credentialIdOf('not-a-url', VALIDATION_ID)).toThrow(IssuerIdentityError)
    expect(() => credentialIdOf(`http://issuer.test/issuers/${'a'.repeat(43)}`, VALIDATION_ID)).toThrow(
      /https/,
    )
    expect(() => credentialIdOf(`${issuerA}?x=1`, VALIDATION_ID)).toThrow(/query or fragment/)
    expect(() => credentialIdOf(`${issuerA}#x`, VALIDATION_ID)).toThrow(/query or fragment/)
  })
})

describe('credentialUrlOf / credentialStatusUrlOf', () => {
  it('constrói `<issuer>/credentials/<id>` e `<id>/status`', () => {
    const credentialId = credentialIdOf(issuerA, VALIDATION_ID)

    expect(credentialUrlOf(issuerA, credentialId)).toBe(`${issuerA}/credentials/${credentialId}`)
    expect(credentialStatusUrlOf(issuerA, credentialId)).toBe(`${issuerA}/credentials/${credentialId}/status`)
  })
})
