import { describe, expect, it } from 'vitest'
import { keysForRow, type EstabelecimentoKeyRow } from './rebuild-keys.service.js'

const row = (overrides: Partial<EstabelecimentoKeyRow> = {}): EstabelecimentoKeyRow => ({
  cnpj_basico: '12345678',
  cnpj_ordem: '0001',
  cnpj_dv: '90',
  tipo_logradouro: 'R',
  logradouro: 'Jose Paulino',
  numero: '123',
  complemento: 'Apto 1',
  bairro: 'Centro',
  cep: '01310100',
  uf: 'SP',
  pais_codigo: null,
  ...overrides,
})

describe('keysForRow', () => {
  it('gera literais `bytea` para endereço nacional completo', () => {
    const patch = keysForRow(row())
    expect(patch).toMatchObject({ basico: '12345678', ordem: '0001', dv: '90' })
    expect(patch.buildingKey).toMatch(/^\\x[0-9a-f]{64}$/)
    expect(patch.unitKey).toMatch(/^\\x[0-9a-f]{64}$/)
  })

  it('deixa as chaves vazias quando falta endereço utilizável', () => {
    expect(keysForRow(row({ cep: null })).buildingKey).toBe('')
    expect(keysForRow(row({ logradouro: null })).buildingKey).toBe('')
    expect(keysForRow(row({ uf: null })).buildingKey).toBe('')
  })

  it('não gera chave para estabelecimento no exterior (`pais_codigo` preenchido)', () => {
    expect(keysForRow(row({ pais_codigo: 999 })).buildingKey).toBe('')
  })
})
