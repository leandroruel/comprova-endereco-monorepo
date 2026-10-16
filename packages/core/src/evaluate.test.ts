import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { evaluateClaim, observationFromSignal } from './assessment.js'
import { loadPolicy } from './policy.js'
import { decide, weightedScore } from './scoring.js'
import type { Signal, Stance } from './types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const policy = loadPolicy(readFileSync(path.resolve(here, '../../../policies/2026.11.1.yaml'), 'utf8'))
const now = new Date('2026-10-10T12:00:00Z')

const sig = (
  checkerId: string,
  stance: Stance,
  strength: number,
  detail: Record<string, unknown> = {},
  confidence = 0.9,
): Signal => ({
  checkerId,
  checkerVersion: '1.0.0',
  stance,
  strength,
  confidence,
  source: 'test',
  observedAt: '2026-10-10T11:59:00Z',
  ttlSeconds: 3600,
  detail,
})

const claim = { id: 'claim-1', type: 'business_registered_address' } as const

/** Compara o pipeline antigo (signals) com o novo (claim + evidence). */
const assertEquivalent = (signals: readonly Signal[]): void => {
  const oldScore = weightedScore(signals, policy, now)
  const oldDecision = decide({ signals, score: oldScore, policy, now })

  const { score, decision } = evaluateClaim({
    claim,
    evidence: signals.map(observationFromSignal),
    policy,
    now,
  })

  expect(score).toBe(oldScore)
  expect(decision.verdict).toBe(oldDecision.verdict)
  expect(decision.confidence).toBe(oldDecision.confidence)
  expect(decision.hardRuleId).toBe(oldDecision.hardRuleId)
  expect(decision.explanation).toBe(oldDecision.explanation)
}

describe('evaluateClaim: invariante de compatibilidade com o pipeline de signals', () => {
  it('SHARED_VIRTUAL com cotenancy neutral + cnefe unknown (neutral != unknown)', () => {
    assertEquivalent([
      sig('document_integrity', 'supports', 0.5),
      sig('registry_status', 'supports', 0.5, { situacao: 'ativa' }),
      sig('cotenancy', 'neutral', 0.7, { verdict_hint: 'SHARED_VIRTUAL', active_cnpj_count: 12 }),
      sig('cnefe_match', 'unknown', 0, { match: 'none' }),
    ])
  })

  it('INSUFFICIENT_EVIDENCE com checkers obrigatorios unknown', () => {
    assertEquivalent([
      sig('document_integrity', 'supports', 0.5),
      sig('registry_status', 'unknown', 0, { reason: 'not_in_registry' }),
      sig('cnefe_match', 'unknown', 0, { match: 'none' }),
      sig('cotenancy', 'unknown', 0, { reason: 'no_profile' }),
    ])
  })

  it('CONFIRMED_COMMERCIAL com cobertura completa', () => {
    assertEquivalent([
      sig('document_integrity', 'supports', 0.5),
      sig('registry_status', 'supports', 0.5, { situacao: 'ativa' }),
      sig('country_check', 'supports', 0.2, { country: 'BR' }),
      sig('cep_consistency', 'supports', 0.6, { cep: '01310100' }),
      sig('cnefe_match', 'supports', 0.6, { match: 'exact_number' }),
      sig('cotenancy', 'supports', 0.4, { other_active_cnpjs: 0 }),
    ])
  })

  it('hard rule FOREIGN e preservada via evaluateClaim', () => {
    assertEquivalent([sig('country_check', 'neutral', 0.9, { verdict_hint: 'FOREIGN' })])
  })

  it('evalua um claim mesmo com evidencia vazia', () => {
    const { score, decision } = evaluateClaim({ claim, evidence: [], policy, now })
    expect(score).toBe(0)
    expect(decision.verdict).toBe('INSUFFICIENT_EVIDENCE')
  })
})
