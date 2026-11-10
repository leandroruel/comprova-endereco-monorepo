import { describe, expect, it } from 'vitest'
import {
  hashHolderAccessToken,
  holderTokenPrefixOf,
  isHolderTokenFormat,
  newHolderAccessToken,
  HOLDER_TOKEN_DOMAIN,
  HOLDER_TOKEN_PREFIX_LENGTH,
} from '../../src/modules/holder/holder-token.js'
import { createHmac } from 'node:crypto'

describe('holder-token — formato', () => {
  it('gera token no formato hlt_ + 43 caracteres base64url', () => {
    const token = newHolderAccessToken()
    expect(token.startsWith('hlt_')).toBe(true)
    expect(token).toMatch(/^hlt_[A-Za-z0-9_-]{43}$/)
  })

  it('gera tokens distintos', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newHolderAccessToken()))
    expect(tokens.size).toBe(200)
  })

  it('prefixo tem 12 caracteres', () => {
    const token = newHolderAccessToken()
    expect(holderTokenPrefixOf(token)).toBe(token.slice(0, HOLDER_TOKEN_PREFIX_LENGTH))
    expect(holderTokenPrefixOf(token)).toHaveLength(12)
  })

  it('valida formato: aceita válido, rejeita malformados', () => {
    expect(isHolderTokenFormat(newHolderAccessToken())).toBe(true)
    expect(isHolderTokenFormat(undefined)).toBe(false)
    expect(isHolderTokenFormat('')).toBe(false)
    expect(isHolderTokenFormat('sem-prefixo')).toBe(false)
    expect(isHolderTokenFormat('hlt_curto')).toBe(false)
    expect(isHolderTokenFormat(`hlt_${'a'.repeat(43)}`)).toBe(true)
    expect(isHolderTokenFormat(`hlt_${'a'.repeat(44)}`)).toBe(false)
    // base64url não usa +/ nem =
    expect(isHolderTokenFormat(`hlt_${'+/=a'.repeat(9)}`)).toBe(false)
  })
})

describe('holder-token — hash', () => {
  it('HMAC-SHA-256 com separação de domínio', () => {
    const token = newHolderAccessToken()
    const pepper = 'pepper-teste'
    const expected = createHmac('sha256', pepper).update(`${HOLDER_TOKEN_DOMAIN}${token}`).digest()
    expect(hashHolderAccessToken(token, pepper).equals(expected)).toBe(true)
    expect(hashHolderAccessToken(token, pepper)).toHaveLength(32)
  })

  it('o mesmo token com peppers diferentes produz hashes distintos', () => {
    const token = newHolderAccessToken()
    expect(hashHolderAccessToken(token, 'a').equals(hashHolderAccessToken(token, 'b'))).toBe(false)
  })

  it('tokens distintos com o mesmo pepper produzem hashes distintos', () => {
    const pepper = 'pepper-teste'
    expect(
      hashHolderAccessToken(newHolderAccessToken(), pepper).equals(
        hashHolderAccessToken(newHolderAccessToken(), pepper),
      ),
    ).toBe(false)
  })

  it('não é o mesmo HMAC de outra função de domínio (sem colisão de domínio)', () => {
    const token = newHolderAccessToken()
    const pepper = 'pepper-teste'
    const otherDomain = createHmac('sha256', pepper).update(`outra-funcao:${token}`).digest()
    expect(hashHolderAccessToken(token, pepper).equals(otherDomain)).toBe(false)
  })
})
