import { describe, expect, it } from 'vitest'
import { PASSWORD_MIN_LENGTH, checkPassword, isPasswordValid } from './password-policy'

describe('política de senha', () => {
  it('exige todos os critérios para uma senha válida', () => {
    expect(isPasswordValid('SenhaForte123!')).toBe(true)
  })

  it('reprova senha sem cada critério faltante', () => {
    expect(isPasswordValid('senhafraca')).toBe(false) // sem maiúscula, número e símbolo
    expect(isPasswordValid('SEMMINUSCULA123!')).toBe(false) // sem minúscula
    expect(isPasswordValid('SemNumero!')).toBe(false) // sem número
    expect(isPasswordValid('SemSimbolo123')).toBe(false) // sem símbolo
    expect(isPasswordValid('Ab1!')).toBe(false) // curta, mesmo com todos os demais critérios
  })

  it('checkPassword descreve cada critério com o estado atual', () => {
    const checks = checkPassword('Ab1!')
    expect(checks.map((check) => check.passed)).toEqual([false, true, true, true, true])
    expect(checks[0]?.label).toContain(`${PASSWORD_MIN_LENGTH}`)
  })
})
