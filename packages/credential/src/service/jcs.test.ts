import { describe, expect, it } from 'vitest'
import { canonicalize, JcsError } from './encoding.service.js'

// Vetores do RFC 8785 (JSON Canonicalization Scheme).
describe('canonicalize (RFC 8785 / JCS)', () => {
  it('reproduz o exemplo do RFC 8785 §3.2.2', () => {
    const value = {
      // O literal do RFC 8785 perde precisão no parse (é justamente o caso que
      // a canonicalização normaliza para 333333333.3333333).
      numbers: [Number('333333333.33333329'), 1e30, 4.5, 2e-3, 1e-27],
      string: '\u20ac$\u000f\nA\'B"\\\\"/',
      literals: [null, true, false],
    }

    expect(canonicalize(value)).toBe(
      String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`,
    )
  })

  it('serializa números como o ECMAScript (RFC 8785 Appendix B)', () => {
    const samples: ReadonlyArray<readonly [number, string]> = [
      [0, '0'],
      [-0, '0'],
      [5e-324, '5e-324'],
      [-5e-324, '-5e-324'],
      [1.7976931348623157e308, '1.7976931348623157e+308'],
      [9007199254740992, '9007199254740992'],
      [295147905179352830000, '295147905179352830000'],
      [9.999999999999997e22, '9.999999999999997e+22'],
      [1e23, '1e+23'],
      [1e21, '1e+21'],
      [0.000001, '0.000001'],
      [333333333.3333333, '333333333.3333333'],
    ]

    for (const [value, expected] of samples) {
      expect(canonicalize(value)).toBe(expected)
    }
  })

  it('ordena as propriedades pelos code units UTF-16 (não por code points)', () => {
    expect(canonicalize({ b: 1, a: 2, A: 3 })).toBe('{"A":3,"a":2,"b":1}')

    // U+1F600 (par substituto D83D DE00) ordena ANTES de U+E000: a ordenação é
    // por code unit, e não por code point (que colocaria U+E000 primeiro).
    const ordered = canonicalize({ '\u{1F600}': 1, '\uE000': 2 })
    expect(ordered).toBe('{"\u{1F600}":1,"\uE000":2}')
  })

  it('normaliza objetos aninhados e preserva a ordem dos arrays', () => {
    expect(canonicalize({ z: { b: [3, 2, 1], a: null }, a: [] })).toBe('{"a":[],"z":{"a":null,"b":[3,2,1]}}')
    expect(canonicalize([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]')
  })

  it('é idempotente sobre a forma canônica (parse → canonicalize)', () => {
    const value = { b: 'São Paulo — çãõ', a: [1, 'two', null], c: { y: true, x: false } }
    const once = canonicalize(value)
    expect(canonicalize(JSON.parse(once))).toBe(once)
  })

  it('aborta com valores que não existem em JSON', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(JcsError)
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(JcsError)
    expect(() => canonicalize(Number.NEGATIVE_INFINITY)).toThrow(JcsError)
    expect(() => canonicalize(undefined)).toThrow(JcsError)
    expect(() => canonicalize(10n)).toThrow(JcsError)
    expect(canonicalize({ ok: undefined })).toBe('{}')
  })
})
