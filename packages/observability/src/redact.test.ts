import { describe, expect, it } from 'vitest'
import { redactDeep, redactString } from './redact.js'

describe('redactString', () => {
  it('mascara CPF em varios formatos', () => {
    expect(redactString('cpf 529.982.247-25 invalido')).toBe('cpf ***REDACTED*** invalido')
    expect(redactString('cpf 52998224725 invalido')).toBe('cpf ***REDACTED*** invalido')
  })

  it('mascara CNPJ em varios formatos', () => {
    expect(redactString('cnpj 11.222.333/0001-81 ok')).toBe('cnpj ***REDACTED*** ok')
    expect(redactString('cnpj 11222333000181 ok')).toBe('cnpj ***REDACTED*** ok')
  })

  it('nao mascara sequencias curtas de digitos', () => {
    expect(redactString('cep 01310-100')).toBe('cep 01310-100')
    expect(redactString('erro 404')).toBe('erro 404')
  })
})

describe('redactDeep', () => {
  it('redige valores de chaves sensiveis', () => {
    const out = redactDeep({
      nome: 'Fulano de Tal',
      address: { logradouro: 'Rua das Flores', numero: '123' },
      tenant_id: 'abc',
    }) as Record<string, unknown>
    expect(out['nome']).toBe('***REDACTED***')
    expect(out['address']).toBe('***REDACTED***')
    expect(out['tenant_id']).toBe('abc')
  })

  it('redige chaves sensiveis aninhadas sob chave neutra', () => {
    const out = redactDeep({ data: { logradouro: 'Rua X', numero: '100' } }) as Record<string, unknown>
    const data = out['data'] as Record<string, unknown>
    expect(data['logradouro']).toBe('***REDACTED***')
    expect(data['numero']).toBe('***REDACTED***')
  })

  it('redige CPF/CNPJ dentro de strings aninhadas em arrays', () => {
    const out = redactDeep({ items: ['doc 11144477735', 'x'] }) as Record<string, unknown>
    expect(out['items']).toEqual(['doc ***REDACTED***', 'x'])
  })

  it('preserva numeros e booleans', () => {
    const out = redactDeep({ n: 42, b: true, nil: null })
    expect(out).toEqual({ n: 42, b: true, nil: null })
  })
})
