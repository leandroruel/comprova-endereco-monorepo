import { describe, expect, it } from 'vitest'
import { IssuerSigningKeyRevocationSchema } from './issuer.schema.js'

describe('IssuerSigningKeyRevocationSchema', () => {
  it('aceita key_id e revoked_at em ISO-8601 UTC', () => {
    expect(
      IssuerSigningKeyRevocationSchema.safeParse({
        key_id: 'key-1',
        revoked_at: '2026-10-19T12:00:00.000Z',
      }).success,
    ).toBe(true)
  })

  it('recusa instante inválido, key_id vazio e campos internos', () => {
    expect(
      IssuerSigningKeyRevocationSchema.safeParse({
        key_id: 'key-1',
        revoked_at: 'ontem',
      }).success,
    ).toBe(false)
    expect(
      IssuerSigningKeyRevocationSchema.safeParse({
        key_id: '',
        revoked_at: '2026-10-19T12:00:00.000Z',
      }).success,
    ).toBe(false)
    expect(
      IssuerSigningKeyRevocationSchema.safeParse({
        key_id: 'key-1',
        revoked_at: '2026-10-19T12:00:00.000Z',
        tenant_id: '11111111-1111-4111-8111-111111111111',
      }).success,
    ).toBe(false)
  })
})
