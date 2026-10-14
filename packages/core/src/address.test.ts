import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  addressKeys,
  canonicalizeAddress,
  normalizeLogradouro,
  normalizeNumero,
  normalizeText,
} from './address.js'

describe('normalizeText', () => {
  it('remove acentos, caixa alta e colapsa espacos', () => {
    expect(normalizeText('  Rua  São José ')).toBe('RUA SAO JOSE')
    expect(normalizeText('Trav. doçaçãø')).toBe('TRAV. DOCACAØ')
  })

  it('propriedade: idempotente para strings arbitrarias', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        const once = normalizeText(s)
        expect(normalizeText(once)).toBe(once)
      }),
      { numRuns: 1000 },
    )
  })
})

describe('normalizeLogradouro', () => {
  it('expande abreviacoes BR', () => {
    expect(normalizeLogradouro('R.', 'Paulista')).toBe('RUA PAULISTA')
    expect(normalizeLogradouro('AV', 'Brigadeiro Faria Lima')).toBe('AVENIDA BRIGADEIRO FARIA LIMA')
    expect(normalizeLogradouro(null, 'Tv. da Sé')).toBe('TRAVESSA DA SE')
    expect(normalizeLogradouro('JD', 'América')).toBe('JARDIM AMERICA')
    expect(normalizeLogradouro('PCA', 'Roosevelt')).toBe('PRACA ROOSEVELT')
    expect(normalizeLogradouro('EST', 'do Morro')).toBe('ESTRADA DO MORRO')
  })

  it('nao altera nome comum que nao e abreviacao', () => {
    expect(normalizeLogradouro(null, 'Alphaville')).toBe('ALPHAVILLE')
  })

  it('propriedade: idempotente', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (a) => {
        const n1 = normalizeLogradouro(a, '')
        expect(normalizeLogradouro(n1, '')).toBe(n1)
      }),
      { numRuns: 500 },
    )
  })
})

describe('normalizeNumero', () => {
  it('normaliza sem numero', () => {
    expect(normalizeNumero('S/N')).toBe('S/N')
    expect(normalizeNumero('s/n')).toBe('S/N')
    expect(normalizeNumero('SN')).toBe('S/N')
    expect(normalizeNumero('Sem número')).toBe('S/N')
  })

  it('limpa prefixos e formatacao', () => {
    expect(normalizeNumero('Nº 123')).toBe('123')
    expect(normalizeNumero('#123')).toBe('123')
    expect(normalizeNumero('123-A')).toBe('123-A')
    expect(normalizeNumero(' 00123 ')).toBe('00123')
  })

  it('ordena canonicamente lote/quadra/km', () => {
    expect(normalizeNumero('LOTE 3, QUADRA 5')).toBe('QD 5 LT 3')
    expect(normalizeNumero('QUADRA 5 LOTE 3')).toBe('QD 5 LT 3')
    expect(normalizeNumero('KM 12,5')).toBe('KM 12,5')
    expect(normalizeNumero('km 4')).toBe('KM 4')
    expect(normalizeNumero('KM 12 LT 2')).toBe('KM 12 LT 2')
  })

  it('propriedade: idempotente', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 30 }), (s) => {
        const n1 = normalizeNumero(s)
        expect(normalizeNumero(n1)).toBe(n1)
      }),
      { numRuns: 500 },
    )
  })
})

describe('addressKeys', () => {
  const base = {
    uf: 'SP',
    municipioIbge: 3550308,
    tipoLogradouro: 'R.',
    logradouro: 'Paulista',
    numero: '123',
    cep: '01310-100',
  }

  it('variacoes de formatacao geram a mesma building key', () => {
    const a = addressKeys(
      canonicalizeAddress({
        ...base,
        tipoLogradouro: 'R.',
        logradouro: 'Paulista',
        numero: '123',
      }),
    )
    const b = addressKeys(
      canonicalizeAddress({
        uf: 'sp',
        municipioIbge: 3550308,
        tipoLogradouro: 'RUA',
        logradouro: 'PAULISTA',
        numero: 'Nº 123',
        cep: '01310100',
      }),
    )
    const c = addressKeys(
      canonicalizeAddress({
        tipoLogradouro: null,
        logradouro: 'rua  paulista',
        numero: '123',
        uf: 'SP',
        municipioIbge: 3550308,
      }),
    )
    expect(b.buildingKey.equals(a.buildingKey)).toBe(true)
    expect(c.buildingKey.equals(a.buildingKey)).toBe(true)
  })

  it('complemento nao altera building key, mas muda unit key', () => {
    const without = addressKeys(canonicalizeAddress({ ...base, complemento: null }))
    const withCompl = addressKeys(canonicalizeAddress({ ...base, complemento: 'Sala 12' }))
    expect(withCompl.buildingKey.equals(without.buildingKey)).toBe(true)
    expect(withCompl.unitKey.equals(without.unitKey)).toBe(false)
  })

  it('numero ou municipio diferente gera building key diferente', () => {
    const a = addressKeys(canonicalizeAddress({ ...base }))
    const b = addressKeys(canonicalizeAddress({ ...base, numero: '124' }))
    const c = addressKeys(canonicalizeAddress({ ...base, municipioIbge: 3106200 }))
    expect(b.buildingKey.equals(a.buildingKey)).toBe(false)
    expect(c.buildingKey.equals(a.buildingKey)).toBe(false)
  })

  it('propriedade: chave estavel sob variacao de caixa/acentos/espacos', () => {
    const streetArb = fc.constantFrom(
      ...([
        ['R.', 'Paulista'],
        ['RUA', 'PAULISTA'],
        [null, 'rua  paulista'],
        ['r', 'paulista'],
      ] as readonly (readonly [string | null, string])[]),
    )
    const numArb = fc.constantFrom(...(['123', ' 123', 'Nº 123', '#123'] as const))
    fc.assert(
      fc.property(streetArb, numArb, ([tipo, logradouro], numero) => {
        const key = addressKeys(
          canonicalizeAddress({
            uf: 'SP',
            municipioIbge: 3550308,
            tipoLogradouro: tipo,
            logradouro,
            numero,
          }),
        ).buildingKey
        return key.equals(
          addressKeys(
            canonicalizeAddress({
              uf: 'SP',
              municipioIbge: 3550308,
              tipoLogradouro: 'R.',
              logradouro: 'Paulista',
              numero: '123',
            }),
          ).buildingKey,
        )
      }),
      { numRuns: 100 },
    )
  })
})
