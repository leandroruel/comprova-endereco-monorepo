import { describe, expect, it } from 'vitest'
import { deepEnrichInputSchema } from './deep-enrich.schema.js'

describe('deepEnrichInputSchema', () => {
  it('aceita a entrada mínima do workflow', () => {
    expect(deepEnrichInputSchema.parse({ tenantId: 't1', validationId: 'v1' })).toEqual({
      tenantId: 't1',
      validationId: 'v1',
    })
  })

  it('aceita maxTier opcional', () => {
    expect(deepEnrichInputSchema.parse({ tenantId: 't1', validationId: 'v1', maxTier: 1 }).maxTier).toBe(1)
  })

  it('rejeita entrada sem tenantId/validationId', () => {
    expect(() => deepEnrichInputSchema.parse({ validationId: 'v1' })).toThrow()
    expect(() => deepEnrichInputSchema.parse({ tenantId: 't1' })).toThrow()
  })

  it('rejeita maxTier não numérico', () => {
    expect(() => deepEnrichInputSchema.parse({ tenantId: 't1', validationId: 'v1', maxTier: '2' })).toThrow()
  })
})
