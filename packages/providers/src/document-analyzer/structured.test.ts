import { describe, expect, it } from 'vitest'
import type { DocumentIntelligenceTable } from '@comprova/contracts'
import {
  addressFromTableCandidates,
  extractTableCandidates,
  holderFromTableCandidates,
  installationNumberFromTableCandidates,
  pickUniqueCandidate,
} from './structured.js'

const table = (headers: string[], rows: string[][]): DocumentIntelligenceTable => ({
  headers,
  rows,
  cells: [],
  bbox: null,
})

describe('extractTableCandidates', () => {
  it('extrai pares rótulo/valor de tabelas com cabeçalho', () => {
    const candidates = extractTableCandidates([
      table(['Titular', 'Instalação'], [['Maria da Silva', '123456789']]),
    ])

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'Maria da Silva' }),
        expect.objectContaining({ value: '123456789' }),
      ]),
    )
  })

  it('ignora cabeçalhos fora do conjunto de rótulos conhecidos', () => {
    const candidates = extractTableCandidates([table(['Consumo', 'Valor'], [['100', '50,00']])])

    expect(candidates).toEqual([])
  })

  it('usa a primeira linha como cabeçalho quando não há headers explícitos', () => {
    const candidates = extractTableCandidates([
      table(
        [],
        [
          ['CEP', 'Endereço'],
          ['01001-000', 'Rua das Flores, 123'],
        ],
      ),
    ])

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: '01001-000' }),
        expect.objectContaining({ value: 'Rua das Flores, 123' }),
      ]),
    )
  })

  it('ignora tabela sem cabeçalho cuja primeira linha não são rótulos conhecidos', () => {
    const candidates = extractTableCandidates([
      table(
        [],
        [
          ['100', '50,00'],
          ['200', '75,00'],
        ],
      ),
    ])

    expect(candidates).toEqual([])
  })
})

describe('pickUniqueCandidate', () => {
  const candidates = extractTableCandidates([table(['Endereço'], [['Rua A, 1'], ['Rua B, 2']])])

  it('retorna null quando o rótulo tem valores divergentes (ambiguidade)', () => {
    expect(pickUniqueCandidate(candidates, ['ENDERECO'])).toBeNull()
  })

  it('retorna o valor quando repetido e idêntico', () => {
    const same = extractTableCandidates([table(['Endereço', 'Endereço'], [['Rua A, 1', 'Rua A, 1']])])
    expect(pickUniqueCandidate(same, ['ENDERECO'])).toMatchObject({ value: 'Rua A, 1' })
  })

  it('retorna null quando o rótulo não existe', () => {
    expect(pickUniqueCandidate(candidates, ['TITULAR'])).toBeNull()
  })
})

describe('addressFromTableCandidates', () => {
  it('monta endereço a partir de rótulos distintos', () => {
    const candidates = extractTableCandidates([
      table(
        ['Logradouro', 'Número', 'Bairro', 'Cidade', 'UF', 'CEP'],
        [['Rua das Flores', '123', 'Centro', 'São Paulo', 'SP', '01001-000']],
      ),
    ])

    const address = addressFromTableCandidates(candidates)

    expect(address).toMatchObject({
      logradouro: 'Rua das Flores',
      numero: '123',
      bairro: 'Centro',
      cidade: 'São Paulo',
      uf: 'SP',
      cep: '01001-000',
    })
    expect(address?.raw).toContain('Rua das Flores')
  })

  it('retorna null quando há apenas número sem logradouro/cidade', () => {
    const candidates = extractTableCandidates([table(['Número'], [['123']])])

    expect(addressFromTableCandidates(candidates)).toBeNull()
  })

  it('retorna null quando o logradouro é ambíguo', () => {
    const candidates = extractTableCandidates([table(['Logradouro'], [['Rua A, 1'], ['Rua B, 2']])])

    const address = addressFromTableCandidates(candidates)

    // Sem logradouro único e sem cidade/UF, não há endereço.
    expect(address).toBeNull()
  })

  it('não confunde endereço de correspondência com fornecimento', () => {
    // `Endereço de Correspondência` não está no conjunto de rótulos; só o
    // endereço de fornecimento explícito é considerado.
    const candidates = extractTableCandidates([
      table(['Endereço de Correspondência'], [['Caixa Postal 100']]),
    ])

    expect(addressFromTableCandidates(candidates)).toBeNull()
  })

  it('não mescla campos de endereço de tabelas distintas', () => {
    // Tabela A tem o logradouro; tabela B tem cidade/UF. Combinar as duas
    // produziria um endereço que não existe em nenhuma fonte.
    const candidates = extractTableCandidates([
      table(['Logradouro', 'Número'], [['Rua da Distribuidora', '1']]),
      table(['Cidade', 'UF'], [['Campinas', 'SP']]),
    ])

    expect(addressFromTableCandidates(candidates)).toBeNull()
  })

  it('retorna null quando fontes distintas produzem endereços divergentes', () => {
    const candidates = extractTableCandidates([
      table(['Logradouro'], [['Rua Incompleta']]),
      table(
        ['Logradouro', 'Número', 'Cidade', 'UF', 'CEP'],
        [['Rua Completa', '42', 'São Paulo', 'SP', '01001-000']],
      ),
    ])

    // Não escolhe arbitrariamente a fonte "mais completa": sem evidência de
    // qual é o endereço de fornecimento, o campo fica ausente.
    expect(addressFromTableCandidates(candidates)).toBeNull()
  })

  it('aceita o endereço quando fontes distintas concordam', () => {
    const row = ['Rua das Flores', '123', 'Centro', 'São Paulo', 'SP', '01001-000']
    const headers = ['Logradouro', 'Número', 'Bairro', 'Cidade', 'UF', 'CEP']
    const candidates = extractTableCandidates([table(headers, [row]), table(headers, [row])])

    expect(addressFromTableCandidates(candidates)).toMatchObject({
      logradouro: 'Rua das Flores',
      numero: '123',
      cidade: 'São Paulo',
      uf: 'SP',
      cep: '01001-000',
    })
  })
})

describe('holderFromTableCandidates', () => {
  it('extrai o titular de rótulo claro', () => {
    const candidates = extractTableCandidates([table(['Titular'], [['Maria da Silva']])])
    expect(holderFromTableCandidates(candidates)).toMatchObject({ name: 'Maria da Silva' })
  })

  it('retorna null quando há titulares divergentes', () => {
    const candidates = extractTableCandidates([table(['Titular'], [['Maria da Silva'], ['João Souza']])])
    expect(holderFromTableCandidates(candidates)).toBeNull()
  })
})

describe('installationNumberFromTableCandidates', () => {
  it('extrai o número da unidade consumidora', () => {
    const candidates = extractTableCandidates([table(['Unidade Consumidora'], [['123456789']])])
    expect(installationNumberFromTableCandidates(candidates)).toMatchObject({ value: '123456789' })
  })

  it('retorna null quando há números divergentes', () => {
    const candidates = extractTableCandidates([table(['Instalação'], [['111'], ['222']])])
    expect(installationNumberFromTableCandidates(candidates)).toBeNull()
  })
})
