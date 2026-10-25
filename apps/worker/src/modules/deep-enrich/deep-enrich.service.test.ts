import { describe, expect, it } from 'vitest'
import type { Signal } from '@comprova/core'
import {
  assessmentObservationsOf,
  outcomeSupersedesCredentials,
  type NextCredentialOutcome,
  type PriorCredentialOutcome,
} from './deep-enrich.service.js'
import type { StandaloneEvidenceRow } from './deep-enrich.persistence.js'

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

const signalOf = (overrides: Partial<Signal> = {}): Signal => ({
  checkerId: 'document_integrity',
  checkerVersion: '1.0.0',
  stance: 'neutral',
  strength: 0.5,
  confidence: 0.8,
  source: 'uploaded_document',
  observedAt: '2026-10-23T12:00:00.000Z',
  ttlSeconds: 86_400,
  detail: { reason: 'ok' },
  ...overrides,
})

const standaloneOf = (overrides: Partial<StandaloneEvidenceRow> = {}): StandaloneEvidenceRow => ({
  id: '00000000-0000-4000-8000-000000000001',
  checker: 'nf3e_verification',
  checkerVersion: '1.0.0+dabc+c1',
  stance: 'supports',
  strength: 0,
  confidence: 0,
  source: 'fiscal_nf3e',
  observedAt: new Date('2026-10-23T12:00:00.000Z'),
  ttlSeconds: 3600,
  detail: { verification: { document: 'authentic' } },
  ...overrides,
})

describe('assessmentObservationsOf', () => {
  it('inclui observações sem signal (fiscal/upload) na avaliação existente', () => {
    const observations = assessmentObservationsOf([signalOf()], [standaloneOf()])

    expect(observations.map((observation) => observation.checker)).toEqual([
      'document_integrity',
      'nf3e_verification',
    ])
    expect(observations[1]).toEqual({
      checker: 'nf3e_verification',
      checkerVersion: '1.0.0+dabc+c1',
      stance: 'supports',
      strength: 0,
      confidence: 0,
      source: 'fiscal_nf3e',
      observedAt: '2026-10-23T12:00:00.000Z',
      ttlSeconds: 3600,
      detail: { verification: { document: 'authentic' } },
    })
  })

  it('preserva a fidelidade de stance dos signals (neutral não vira unknown)', () => {
    const [observation] = assessmentObservationsOf([signalOf({ stance: 'neutral' })], [])
    expect(observation?.stance).toBe('neutral')
  })
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
