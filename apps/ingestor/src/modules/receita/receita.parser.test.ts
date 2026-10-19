import { describe, expect, it } from 'vitest'
import { parseLine, parseMunicipioLine, toEstabelecimentoValues } from './receita.parser.js'

/** Linha de 28 colunas do layout da Receita; overrides por índice. */
const line = (overrides: Readonly<Record<number, string>> = {}): string => {
  const cols = Array.from({ length: 28 }, () => '')
  cols[0] = '12345678'
  cols[1] = '0001'
  cols[2] = '90'
  cols[3] = '1'
  cols[4] = 'Padaria X'
  cols[5] = '2'
  cols[6] = '20200102'
  cols[9] = '105'
  cols[10] = '20100506'
  cols[11] = '4721102'
  cols[12] = '6201500'
  cols[13] = 'R'
  cols[14] = 'Jose Paulino'
  cols[15] = '123'
  cols[16] = 'Apto 1'
  cols[17] = 'Centro'
  cols[18] = '01310100'
  cols[19] = 'SP'
  cols[20] = '7107'
  cols[21] = '11'
  cols[22] = '33334444'
  cols[27] = 'Contato@Example.com'
  for (const [index, value] of Object.entries(overrides)) cols[Number(index)] = value
  return cols.join(';')
}

describe('parseLine', () => {
  it('divide por `;` e remove as aspas externas de cada campo', () => {
    expect(parseLine('a;b;c')).toEqual(['a', 'b', 'c'])
    expect(parseLine('"a";b')).toEqual(['a', 'b'])
  })

  it('não quebra dentro de aspas', () => {
    expect(parseLine('a;"b;c";d')).toEqual(['a', 'b;c', 'd'])
  })

  it('preserva campo vazio à direita', () => {
    expect(parseLine('a;')).toEqual(['a', ''])
  })

  it('remove aspas em qualquer posição e tolera aspas não fechadas', () => {
    expect(parseLine('a"b"c;d')).toEqual(['abc', 'd'])
    expect(parseLine('"a;b')).toEqual(['a;b'])
  })

  it('preserva campos vazios no meio', () => {
    expect(parseLine(';')).toEqual(['', ''])
    expect(parseLine('a;;b')).toEqual(['a', '', 'b'])
  })
})

describe('toEstabelecimentoValues', () => {
  it('mapeia as colunas do layout da Receita', () => {
    const values = toEstabelecimentoValues(parseLine(line()), '2026-09-01')

    expect(values).toMatchObject({
      cnpjBasico: '12345678',
      cnpjOrdem: '0001',
      cnpjDv: '90',
      matrizFilial: 1,
      nomeFantasia: 'Padaria X',
      situacaoCadastral: 2,
      dataSituacao: '2020-01-02',
      motivoSituacao: null,
      dataAbertura: '2010-05-06',
      cnaePrincipal: '4721102',
      cnaesSecundarios: ['6201500'],
      tipoLogradouro: 'R',
      logradouro: 'Jose Paulino',
      numero: '123',
      complemento: 'Apto 1',
      bairro: 'Centro',
      cep: '01310100',
      uf: 'SP',
      municipioReceita: 7107,
      municipioIbge: null,
      paisCodigo: 105,
      cidadeExterior: null,
      telefone: '1133334444',
      emailDomain: 'example.com',
      snapshotMonth: '2026-09-01',
    })
    expect(values?.buildingKey).toBeInstanceOf(Buffer)
    expect(values?.unitKey).toBeInstanceOf(Buffer)
  })

  it('descarta linha sem CNPJ básico válido', () => {
    expect(toEstabelecimentoValues(parseLine(line({ 0: '123' })), '2026-09-01')).toBeNull()
  })

  it('não gera chave de endereço para estabelecimento no exterior', () => {
    const values = toEstabelecimentoValues(parseLine(line({ 8: 'LISBOA', 9: '999' })), '2026-09-01')
    expect(values?.buildingKey).toBeNull()
    expect(values?.unitKey).toBeNull()
    expect(values?.cidadeExterior).toBe('LISBOA')
  })

  it('só aceita CEP de 8 dígitos', () => {
    expect(toEstabelecimentoValues(parseLine(line({ 18: '123' })), '2026-09-01')?.cep).toBeNull()
    expect(toEstabelecimentoValues(parseLine(line({ 18: '01310-100' })), '2026-09-01')?.cep).toBe('01310100')
  })
})

describe('parseMunicipioLine', () => {
  it('lê código e nome normalizado', () => {
    expect(parseMunicipioLine('7107;São Paulo')).toEqual({
      codigoReceita: 7107,
      nomeNorm: 'SAO PAULO',
    })
  })

  it('descarta linhas vazias ou sem nome', () => {
    expect(parseMunicipioLine('')).toBeNull()
    expect(parseMunicipioLine('   ')).toBeNull()
    expect(parseMunicipioLine('7107')).toBeNull()
    expect(parseMunicipioLine(';SEM CODIGO')).toBeNull()
  })
})
