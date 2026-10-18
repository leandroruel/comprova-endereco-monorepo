import { describe, expect, it } from 'vitest'
import { keyPrefixOf, makeApiKeyHasher, newApiKey } from './api-keys.js'

describe('api-keys', () => {
  it('gera a chave no formato do prefixo indexado', () => {
    const plaintext = newApiKey()
    expect(plaintext).toMatch(/^cvk_[A-Za-z0-9_-]{32}$/)
    expect(keyPrefixOf(plaintext)).toBe(plaintext.slice(0, 12))
    expect(plaintext.startsWith(keyPrefixOf(plaintext))).toBe(true)
  })

  it('verifica o HMAC que o seed grava', () => {
    const hasher = makeApiKeyHasher('pepper-de-teste')
    const plaintext = newApiKey()
    const stored = hasher.hash(plaintext)

    expect(stored).toHaveLength(32)
    expect(hasher.verify(stored, plaintext)).toBe(true)
    expect(hasher.verify(stored, `${plaintext}x`)).toBe(false)
    expect(hasher.verify(hasher.hash('outra-chave'), plaintext)).toBe(false)
  })

  it('não verifica com outro pepper', () => {
    const plaintext = newApiKey()
    const stored = makeApiKeyHasher('pepper-a').hash(plaintext)
    expect(makeApiKeyHasher('pepper-b').verify(stored, plaintext)).toBe(false)
  })

  it('não autentica um hash que não é HMAC do formato (argon2 do seed antigo)', () => {
    const hasher = makeApiKeyHasher('pepper-de-teste')
    const argon2Like = Buffer.from('$argon2id$v=19$m=19456,t=2,p=1$abcdefghijklmnop$qrstuvwxyz012345')
    expect(hasher.verify(argon2Like, newApiKey())).toBe(false)
  })
})
