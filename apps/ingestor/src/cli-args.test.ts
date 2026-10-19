import { describe, expect, it } from 'vitest'
import { flagNumber, flagValue, parseSnapshotMonth } from './cli-args.js'

describe('flagValue', () => {
  it('devolve o valor seguinte e `undefined` quando a flag não aparece', () => {
    expect(flagValue(['--snapshot', '2026-09'], '--snapshot')).toBe('2026-09')
    expect(flagValue(['--report'], '--snapshot')).toBeUndefined()
  })

  it('recusa flag presente sem operando', () => {
    expect(() => flagValue(['--snapshot'], '--snapshot')).toThrow(/exige um valor/)
  })
})

describe('flagNumber', () => {
  it('devolve número positivo e `undefined` quando ausente', () => {
    expect(flagNumber(['--limit', '10'], '--limit')).toBe(10)
    expect(flagNumber([], '--limit')).toBeUndefined()
  })

  it('recusa valor ausente, não numérico, não positivo ou que seja outra flag', () => {
    expect(() => flagNumber(['--limit'], '--limit')).toThrow(/exige um valor/)
    for (const args of [
      ['--limit', 'abc'],
      ['--limit', '0'],
      ['--limit', '-5'],
      ['--limit', '--report'],
    ]) {
      expect(() => flagNumber(args, '--limit')).toThrow(/inválido/)
    }
  })
})

describe('parseSnapshotMonth', () => {
  it('normaliza YYYY-MM para o dia 1º do mês', () => {
    expect(parseSnapshotMonth('2026-09')).toBe('2026-09-01')
    expect(parseSnapshotMonth('2026-01')).toBe('2026-01-01')
    expect(parseSnapshotMonth('2026-12')).toBe('2026-12-01')
    expect(parseSnapshotMonth(' 2026-09 ')).toBe('2026-09-01')
  })

  it('recusa ausência de valor', () => {
    expect(() => parseSnapshotMonth(undefined)).toThrow(/obrigat|obrigatório/i)
    expect(() => parseSnapshotMonth('')).toThrow(/obrigat/i)
    expect(() => parseSnapshotMonth('   ')).toThrow(/obrigat/i)
  })

  it('recusa formatos inválidos', () => {
    for (const value of ['2026', '2026-9', '26-09', '2026-00', '2026-13', '2026-09-01', 'abril']) {
      expect(() => parseSnapshotMonth(value)).toThrow(/inválido/)
    }
  })

  it('não ecoa o valor inválido como valor aceito', () => {
    expect(() => parseSnapshotMonth('2026-13')).toThrow(/"2026-13"/)
  })
})
