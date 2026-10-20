import { describe, expect, it } from 'vitest'
import {
  outcomeSupersedesCredentials,
  type NextCredentialOutcome,
  type PriorCredentialOutcome,
} from './deep-enrich.service.js'

const previous = (overrides: Partial<PriorCredentialOutcome> = {}): PriorCredentialOutcome => ({
  status: 'completed',
  verdict: 'CONFIRMED_COMMERCIAL',
  evidenceSetHash: 'a'.repeat(64),
  policyHash: 'b'.repeat(64),
  scorerVersion: '1',
  ...overrides,
})

const next = (overrides: Partial<NextCredentialOutcome> = {}): NextCredentialOutcome => ({
  stillPartial: false,
  verdict: 'CONFIRMED_COMMERCIAL',
  evidenceSetHash: 'a'.repeat(64),
  policyHash: 'b'.repeat(64),
  scorerVersion: '1',
  ...overrides,
})

describe('outcomeSupersedesCredentials (C1)', () => {
  it('não revoga sem conclusão anterior', () => {
    expect(outcomeSupersedesCredentials(previous({ status: 'queued' }), next())).toBe(false)
    expect(outcomeSupersedesCredentials(previous({ status: 'partial' }), next())).toBe(false)
  })

  it('replay idêntico NÃO revoga', () => {
    expect(outcomeSupersedesCredentials(previous(), next())).toBe(false)
  })

  it('mudança de veredito, evidências, policy ou scorer revoga', () => {
    expect(outcomeSupersedesCredentials(previous(), next({ verdict: 'NOT_FOUND' }))).toBe(true)
    expect(outcomeSupersedesCredentials(previous(), next({ evidenceSetHash: 'c'.repeat(64) }))).toBe(true)
    expect(outcomeSupersedesCredentials(previous(), next({ policyHash: 'd'.repeat(64) }))).toBe(true)
    expect(outcomeSupersedesCredentials(previous(), next({ scorerVersion: '2' }))).toBe(true)
  })

  it('voltar a parcial depois de concluída revoga', () => {
    expect(outcomeSupersedesCredentials(previous(), next({ stillPartial: true }))).toBe(true)
  })
})
