import { describe, expect, it } from 'vitest'
import { partitionPlan } from './partitions.service.js'

const TABLES = ['validation', 'signal', 'usage_event'] as const

describe('partitionPlan', () => {
  it('cobre 2 meses atrás até monthsAhead, para as 3 tabelas particionadas', () => {
    const plans = partitionPlan(new Date(2026, 5, 15), 2)
    expect(plans).toHaveLength(5 * TABLES.length)
    expect(plans.map((p) => p.table)).toEqual([...TABLES, ...TABLES, ...TABLES, ...TABLES, ...TABLES])
    expect(plans.map((p) => p.suffix)).toEqual([
      ...TABLES.map(() => '2026_04'),
      ...TABLES.map(() => '2026_05'),
      ...TABLES.map(() => '2026_06'),
      ...TABLES.map(() => '2026_07'),
      ...TABLES.map(() => '2026_08'),
    ])
  })

  it('gera limites ISO de 10 caracteres, com end posterior a start', () => {
    const plans = partitionPlan(new Date(2026, 5, 15), 6)
    for (const plan of plans) {
      expect(plan.start).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(plan.end).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(plan.end > plan.start).toBe(true)
    }
  })

  it('usa o default de 6 meses à frente quando não informado', () => {
    expect(partitionPlan(new Date(2026, 5, 15))).toHaveLength(9 * TABLES.length)
  })
})
