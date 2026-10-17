import { describe, expect, it } from 'vitest'
import { registryRecordFromDeepContext } from './deep-enrich.registry.js'

describe('registryRecordFromDeepContext', () => {
  it('retorna null quando o deep_context é null', () => {
    expect(registryRecordFromDeepContext(null)).toBeNull()
  })

  it('retorna null quando não há record objeto', () => {
    expect(registryRecordFromDeepContext({})).toBeNull()
    expect(registryRecordFromDeepContext({ record: null })).toBeNull()
    expect(registryRecordFromDeepContext({ record: 'nope' })).toBeNull()
  })

  it('mapeia campos com defaults e coerção de string', () => {
    const mapped = registryRecordFromDeepContext({
      docDigitsValid: true,
      record: { cnpjBasico: 1234, matrizFilial: '2' },
    })
    expect(mapped).not.toBeNull()
    expect(mapped?.docDigitsValid).toBe(true)
    expect(mapped?.record.cnpjBasico).toBe('1234')
    expect(mapped?.record.matrizFilial).toBe(2)
    expect(mapped?.record.situacaoCadastral).toBe(0)
    expect(mapped?.record.nomeFantasia).toBeNull()
    expect(mapped?.record.buildingKey).toBeNull()
    expect(mapped?.record.unitKey).toBeNull()
  })

  it('docDigitsValid é false quando não é exatamente true', () => {
    const mapped = registryRecordFromDeepContext({ record: {}, docDigitsValid: 'yes' })
    expect(mapped?.docDigitsValid).toBe(false)
  })

  it('decodifica buildingKey/unitKey de hex para buffer', () => {
    const mapped = registryRecordFromDeepContext({
      record: { buildingKey: '00ff10', unitKey: 'abcd' },
    })
    expect(mapped?.record.buildingKey).toEqual(Buffer.from('00ff10', 'hex'))
    expect(mapped?.record.unitKey).toEqual(Buffer.from('abcd', 'hex'))
  })

  it('ignora chaves desconhecidas e mantém campos opcionais nulos', () => {
    const mapped = registryRecordFromDeepContext({
      record: { cnaesSecundarios: ['A', 'B'], telefone: '123', extra: 'ignored' },
    })
    expect(mapped?.record.cnaesSecundarios).toEqual(['A', 'B'])
    expect(mapped?.record.telefone).toBe('123')
    expect(mapped?.record.emailDomain).toBeNull()
  })
})
