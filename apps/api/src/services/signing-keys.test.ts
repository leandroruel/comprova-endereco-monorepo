import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeSigningKeyResolver, SigningKeyConfigError } from './signing-keys.js'

const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

const ed25519Pem = (): string =>
  generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()

const entry = (tenantId: string, keyId: string, pem: string): string =>
  JSON.stringify([{ tenant_id: tenantId, key_id: keyId, private_key_pem: pem }])

describe('makeSigningKeyResolver', () => {
  it('resolve o material pelo par (tenant, key_id) e devolve null para o resto', () => {
    const resolve = makeSigningKeyResolver(entry(TENANT, 'key-1', ed25519Pem()))

    const key = resolve(TENANT, 'key-1')
    expect(key).not.toBeNull()
    expect(key!.asymmetricKeyType).toBe('ed25519')
    expect(createPublicKey(key!).asymmetricKeyType).toBe('ed25519')

    // Mesmo tenant, outro key_id; outro tenant, mesmo key_id: sem material.
    expect(resolve(TENANT, 'key-2')).toBeNull()
    expect(resolve(OTHER, 'key-1')).toBeNull()
  })

  it('lista vazia não resolve ninguém (não existe chave global de reserva)', () => {
    const resolve = makeSigningKeyResolver('[]')
    expect(resolve(TENANT, 'key-1')).toBeNull()
  })

  it('normaliza o tenant_id para minúsculas (o escopo é o digest do texto)', () => {
    const mixed = 'AaAaAaAa-BbBb-4CcC-8DdD-EeEeEeEeEeEe'
    const resolve = makeSigningKeyResolver(entry(mixed, 'key-1', ed25519Pem()))

    expect(resolve(mixed.toLowerCase(), 'key-1')).not.toBeNull()
  })

  it('recusa key_id que não serve como fragmento de URL', () => {
    for (const invalid of ['key 1', 'key#1', 'key?1', '   ']) {
      expect(() => makeSigningKeyResolver(entry(TENANT, invalid, ed25519Pem()))).toThrow(
        SigningKeyConfigError,
      )
    }
  })

  it('recusa JSON inválido, entrada duplicada e chave não-Ed25519', () => {
    expect(() => makeSigningKeyResolver('nope')).toThrow(SigningKeyConfigError)

    const pem = ed25519Pem()
    const duplicated = JSON.stringify([
      { tenant_id: TENANT, key_id: 'key-1', private_key_pem: pem },
      { tenant_id: TENANT, key_id: 'key-1', private_key_pem: pem },
    ])
    expect(() => makeSigningKeyResolver(duplicated)).toThrow(/duplicate/)

    const rsaPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString()
    expect(() => makeSigningKeyResolver(entry(TENANT, 'key-1', rsaPem))).toThrow(/Ed25519/)
  })
})
