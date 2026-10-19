import { describe, expect, it } from 'vitest'
import {
  CREDENTIAL_STATUS_TYPE,
  CredentialStatusDocumentSchema,
  CredentialStatusSchema,
} from './status.schema.js'

describe('CredentialStatusSchema', () => {
  it('aceita exatamente o tipo/URL suportados', () => {
    const value = {
      id: 'https://issuer.test/issuers/aaaa/credentials/bbbb/status',
      type: CREDENTIAL_STATUS_TYPE,
    }
    expect(CredentialStatusSchema.safeParse(value).success).toBe(true)
  })

  it('recusa outros tipos de status e campos extras', () => {
    const base = {
      id: 'https://issuer.test/issuers/aaaa/credentials/bbbb/status',
      type: CREDENTIAL_STATUS_TYPE,
    }
    expect(CredentialStatusSchema.safeParse({ ...base, type: 'StatusList2021Entry' }).success).toBe(false)
    expect(CredentialStatusSchema.safeParse({ ...base, extra: true }).success).toBe(false)
  })
})

describe('CredentialStatusDocumentSchema', () => {
  it('aceita somente ACTIVE e REVOKED', () => {
    expect(CredentialStatusDocumentSchema.safeParse({ status: 'ACTIVE' }).success).toBe(true)
    expect(CredentialStatusDocumentSchema.safeParse({ status: 'REVOKED' }).success).toBe(true)
  })

  it('recusa status desconhecido, valor ausente e dados internos', () => {
    expect(CredentialStatusDocumentSchema.safeParse({ status: 'UNKNOWN' }).success).toBe(false)
    expect(CredentialStatusDocumentSchema.safeParse({}).success).toBe(false)
    expect(
      CredentialStatusDocumentSchema.safeParse({
        status: 'ACTIVE',
        tenant_id: '11111111-1111-4111-8111-111111111111',
      }).success,
    ).toBe(false)
  })
})
