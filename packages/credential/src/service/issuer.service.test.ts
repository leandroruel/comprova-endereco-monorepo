import { describe, expect, it } from 'vitest'
import {
  ISSUERS_PATH,
  issuerIdOf,
  issuerScopeOf,
  localIssuer,
  parseIssuerOrigin,
  verificationMethodOf,
} from './issuer.service.js'

const ORIGIN = 'https://issuer.test'
const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222'

describe('parseIssuerOrigin', () => {
  it('normaliza a origem (host canônico, porta default do https removida)', () => {
    expect(parseIssuerOrigin('https://Issuer.TEST')).toBe('https://issuer.test')
    expect(parseIssuerOrigin('https://issuer.test:443')).toBe('https://issuer.test')
    expect(parseIssuerOrigin('https://issuer.test:8443')).toBe('https://issuer.test:8443')
    expect(parseIssuerOrigin('https://issuer.test/')).toBe('https://issuer.test')
  })

  it('exige https: — o identificador do issuer é uma URL pública', () => {
    expect(() => parseIssuerOrigin('http://issuer.test')).toThrow(/https/)
    expect(() => parseIssuerOrigin('ftp://issuer.test')).toThrow(/https/)
  })

  it('recusa path, query, fragmento e credenciais (a origem é "bare")', () => {
    expect(() => parseIssuerOrigin('https://issuer.test/credentials')).toThrow(/bare origin/)
    expect(() => parseIssuerOrigin('https://issuer.test?a=1')).toThrow(/bare origin/)
    expect(() => parseIssuerOrigin('https://issuer.test#x')).toThrow(/bare origin/)
    expect(() => parseIssuerOrigin('https://user:secret@issuer.test')).toThrow(/credentials/)
  })

  it('recusa o que não é URL absoluta com host', () => {
    expect(() => parseIssuerOrigin('issuer.test')).toThrow(/not a URL/)
    expect(() => parseIssuerOrigin('')).toThrow(/not a URL/)
    expect(() => parseIssuerOrigin('/issuers/1')).toThrow(/not a URL/)
  })
})

describe('issuerIdOf', () => {
  it('é determinístico e não expõe o tenant_id interno', () => {
    const id = issuerIdOf(ORIGIN, TENANT)

    expect(id).toBe(issuerIdOf(ORIGIN, TENANT))
    expect(id).toMatch(/^https:\/\/issuer\.test\/issuers\/[A-Za-z0-9_-]{43}$/)
    expect(id).toBe(`${ORIGIN}/${ISSUERS_PATH}/${issuerScopeOf(TENANT)}`)
    expect(id).not.toContain(TENANT)
  })

  it('isola tenants e origens', () => {
    expect(issuerIdOf(ORIGIN, TENANT)).not.toBe(issuerIdOf(ORIGIN, OTHER_TENANT))
    expect(issuerIdOf(ORIGIN, TENANT)).not.toBe(issuerIdOf('https://outro.test', TENANT))
  })

  it('valida a origem em vez de aceitar qualquer string', () => {
    expect(() => issuerIdOf('http://issuer.test', TENANT)).toThrow(/https/)
    expect(() => issuerIdOf('https://issuer.test/api', TENANT)).toThrow(/bare origin/)
  })
})

describe('localIssuer / verificationMethodOf', () => {
  it('a identidade do issuer é estável na rotação de chave (só o fragmento muda)', () => {
    const key1 = localIssuer(ORIGIN, TENANT, 'key-1')
    const key2 = localIssuer(ORIGIN, TENANT, 'key-2')

    expect(key1.id).toBe(key2.id)
    expect(verificationMethodOf(key1)).toBe(`${issuerIdOf(ORIGIN, TENANT)}#key-1`)
    expect(verificationMethodOf(key2)).toBe(`${issuerIdOf(ORIGIN, TENANT)}#key-2`)
    expect(verificationMethodOf(key1)).not.toBe(verificationMethodOf(key2))
  })

  it('o verificationMethod é uma URL vinculada ao issuer (fragmento não vazio)', () => {
    const method = verificationMethodOf(localIssuer(ORIGIN, TENANT, 'key-1'))
    const url = new URL(method)

    expect(url.origin).toBe(ORIGIN)
    expect(url.hash).toBe('#key-1')
    expect(method.startsWith(`${localIssuer(ORIGIN, TENANT, 'key-1').id}#`)).toBe(true)
  })

  it('recusa keyId que não pode ser fragmento de URL', () => {
    expect(() => localIssuer(ORIGIN, TENANT, '')).toThrow(/fragment/)
    expect(() => verificationMethodOf({ id: issuerIdOf(ORIGIN, TENANT), keyId: 'key 1' })).toThrow(/fragment/)
    expect(() => verificationMethodOf({ id: issuerIdOf(ORIGIN, TENANT), keyId: 'key#1' })).toThrow(/fragment/)
  })
})
