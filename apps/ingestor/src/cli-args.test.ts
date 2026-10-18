import { describe, expect, it } from 'vitest'
import { parseSnapshotMonth } from './cli-args.js'

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
