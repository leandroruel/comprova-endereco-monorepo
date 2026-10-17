import { canonicalJson } from '@comprova/core'
import { describe, expect, it } from 'vitest'
import type { AssertionPayload } from './assertion.js'
import { canonicalAssertion, canonicalAssertionBytes } from './canonical.js'

const payload = (): AssertionPayload => ({
  format: 'comprova-assertion-v1',
  issuer: {
    id: 'comprova:issuer:11111111-1111-4111-8111-111111111111',
    authorization: { scopes: ['validate:write', 'validate:read'] },
  },
  subject: { id: 'sha256:' + 'a'.repeat(64), doc_type: 'CNPJ' },
  claim: {
    id: '22222222-2222-4222-8222-222222222222',
    type: 'business_registered_address',
    subject_type: 'organization',
    target: {
      type: 'address',
      id: '33333333-3333-4333-8333-333333333333',
      building_key: 'b64:AAAA',
    },
  },
  evidence: {
    set_hash: 'b'.repeat(64),
    summary: { supporting: 1, contradicting: 0, unknown: 0 },
    observations: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        checker: 'registry_match',
        checker_version: '1',
        stance: 'supports',
        strength: 0.9,
        confidence: 0.8,
        source: 'receita',
        observed_at: '2026-01-02T03:04:05.000Z',
        evidence_sha256: 'c'.repeat(64),
        detail: { nested: { b: 2, a: 1 }, list: [1, 'two', null], unicode: 'São Paulo — çãõ' },
      },
    ],
  },
  policy: { version: '2026.13.1', hash: 'd'.repeat(64) },
  algorithm: { scorer_version: '1' },
  result: {
    status: 'completed',
    verdict: 'CONFIRMED_COMMERCIAL',
    score: 0.1,
    confidence: 0.8,
    explanation: {
      code: 'ADDRESS_CONFIRMED',
      summary: 'ok',
      supporting_evidence: ['44444444-4444-4444-8444-444444444444'],
      contradicting_evidence: [],
    },
  },
  legal_basis: 'FRAUD_PREVENTION',
  timestamps: {
    created_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    expires_at: '2026-01-31T00:00:00.000Z',
  },
})

const reorderKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reorderKeysDeep)
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).reverse()
    return Object.fromEntries(entries.map(([k, v]) => [k, reorderKeysDeep(v)]))
  }
  return value
}

describe('canonicalAssertion', () => {
  it('é independente da ordem das propriedades (inclusive aninhadas)', () => {
    const a = payload()
    const b = reorderKeysDeep(a) as AssertionPayload
    expect(canonicalAssertion(b)).toBe(canonicalAssertion(a))
    expect(canonicalAssertionBytes(b)).toEqual(canonicalAssertionBytes(a))
  })

  it('é estável no transporte JSON (parse/stringify preservam os bytes canônicos)', () => {
    const a = payload()
    const transported = JSON.parse(JSON.stringify(a)) as AssertionPayload
    expect(canonicalAssertion(transported)).toBe(canonicalAssertion(a))
  })

  it('canonicaliza `detail` jsonb com chaves ordenadas', () => {
    const a = payload()
    const b = payload()
    b.evidence.observations[0]!.detail = {
      list: [1, 'two', null],
      unicode: 'São Paulo — çãõ',
      nested: { a: 1, b: 2 },
    }
    expect(canonicalAssertion(b)).toBe(canonicalAssertion(a))
  })

  it('preserva a ordem de arrays como significativa (por isso o builder ordena as observações)', () => {
    const a = payload()
    const b = payload()
    b.evidence.observations = [
      { ...a.evidence.observations[0]!, id: '55555555-5555-4555-8555-555555555555' },
      { ...a.evidence.observations[0]!, id: '44444444-4444-4444-8444-444444444444' },
    ]
    expect(canonicalAssertion(b)).not.toBe(canonicalAssertion(a))
  })

  it('preserva números, strings, `null` e arrays sem alterar valores', () => {
    const a = payload()
    const text = canonicalAssertion(a)
    expect(text).toContain('"score":0.1')
    expect(text).toContain('São Paulo — çãõ')
    expect(text).toContain('"completed_at":"2026-01-01T00:00:01.000Z"')
    expect(text).toContain('[1,"two",null]')
  })

  it('trata `null` como valor e descarta propriedades `undefined`', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}')
    // Propriedades `undefined` são descartadas — por isso o payload exige `null`
    // explícito (forma fixa), e não campos opcionais.
    expect(canonicalJson({ a: undefined })).toBe('{}')
    expect(canonicalJson(undefined)).toBe('null')
  })
})
