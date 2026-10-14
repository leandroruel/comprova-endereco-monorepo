import { describe, expect, it } from 'vitest'
import { digitsOnly, isValidCnpj, isValidCpf, isValidDocument } from './doc.js'

describe('isValidCpf', () => {
  it('aceita CPFs validos com e sem mascara', () => {
    expect(isValidCpf('52998224725')).toBe(true)
    expect(isValidCpf('529.982.247-25')).toBe(true)
    expect(isValidCpf('11144477735')).toBe(true)
  })

  it('rejeita digitos verificadores invalidos', () => {
    expect(isValidCpf('52998224724')).toBe(false)
    expect(isValidCpf('11144477730')).toBe(false)
  })

  it('rejeita repetidos, tamanho errado e vazios', () => {
    expect(isValidCpf('11111111111')).toBe(false)
    expect(isValidCpf('00000000000')).toBe(false)
    expect(isValidCpf('123')).toBe(false)
    expect(isValidCpf('')).toBe(false)
    expect(isValidCpf('abcdefghijk')).toBe(false)
  })
})

describe('isValidCnpj', () => {
  it('aceita CNPJs validos com e sem mascara', () => {
    expect(isValidCnpj('11222333000181')).toBe(true)
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true)
    expect(isValidCnpj('00000000000191')).toBe(true)
  })

  it('rejeita digitos verificadores invalidos', () => {
    expect(isValidCnpj('11222333000180')).toBe(false)
    expect(isValidCnpj('11222333000191')).toBe(false)
  })

  it('rejeita repetidos e tamanho errado', () => {
    expect(isValidCnpj('00000000000000')).toBe(false)
    expect(isValidCnpj('11111111111111')).toBe(false)
    expect(isValidCnpj('1234567890123')).toBe(false)
  })
})

describe('digitsOnly e isValidDocument', () => {
  it('remove nao-digitos', () => {
    expect(digitsOnly('11.222.333/0001-81')).toBe('11222333000181')
    expect(digitsOnly('  529.982.247-25 ')).toBe('52998224725')
  })

  it('valida por tipo', () => {
    expect(isValidDocument('CNPJ', '11.222.333/0001-81')).toBe(true)
    expect(isValidDocument('CPF', '529.982.247-25')).toBe(true)
    expect(isValidDocument('CNPJ', '529.982.247-25')).toBe(false)
    expect(isValidDocument('CPF', '11.222.333/0001-81')).toBe(false)
  })
})
