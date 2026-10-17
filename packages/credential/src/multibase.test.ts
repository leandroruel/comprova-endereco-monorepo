import { describe, expect, it } from 'vitest'
import {
  base58BtcDecode,
  base58BtcEncode,
  decodeMultibaseBase58Btc,
  encodeMultibaseBase58Btc,
  MultibaseError,
} from './multibase.js'

// `proofValue` do vetor normativo B.3 (W3C Data Integrity EdDSA Cryptosuites).
const VECTOR_PROOF_VALUE =
  'z2HnFSSPPBzR36zdDgK8PbEHeXbR56YF24jwMpt3R1eHXQzJDMWS93FCzpvJpwTWd3GAVFuUfjoJdcnTMuVor51aX'
const VECTOR_SIGNATURE_HEX =
  '407cd12654b33d718ecbb99179a1506daaa849450bf3fc523cce3e1c96f8b80351da3f253d725c6f00b07c9e5448d50b3ef78012b9ab54255116d069c6dd2808'

describe('base58btc / Multibase', () => {
  it('faz round-trip preservando bytes e zeros à esquerda', () => {
    const cases = [
      new Uint8Array(),
      Uint8Array.from([0]),
      Uint8Array.from([0, 0]),
      Uint8Array.from([0, 0, 1]),
      Uint8Array.from([255, 254, 1]),
      Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    ]
    for (const bytes of cases) {
      expect(base58BtcDecode(base58BtcEncode(bytes))).toEqual(bytes)
    }
  })

  it('usa "1" para cada byte zero à esquerda', () => {
    expect(base58BtcEncode(Uint8Array.from([0]))).toBe('1')
    expect(base58BtcEncode(Uint8Array.from([0, 0]))).toBe('11')
    expect(base58BtcDecode('11')).toEqual(Uint8Array.from([0, 0]))
  })

  it('codifica o cabeçalho Multibase base58btc ("z")', () => {
    const bytes = Uint8Array.from([1, 0])
    expect(encodeMultibaseBase58Btc(bytes)).toBe(`z${base58BtcEncode(bytes)}`)
    expect(decodeMultibaseBase58Btc(encodeMultibaseBase58Btc(bytes))).toEqual(bytes)
  })

  it('reproduz o `proofValue` do vetor normativo B.3', () => {
    const bytes = decodeMultibaseBase58Btc(VECTOR_PROOF_VALUE)
    expect(Buffer.from(bytes).toString('hex')).toBe(VECTOR_SIGNATURE_HEX)
    expect(encodeMultibaseBase58Btc(bytes)).toBe(VECTOR_PROOF_VALUE)
  })

  it('rejeita cabeçalho e caracteres inválidos', () => {
    expect(() => decodeMultibaseBase58Btc('2HnFSSPPBz')).toThrow(MultibaseError)
    expect(() => base58BtcDecode('0OIl')).toThrow(MultibaseError)
  })
})
