import { describe, expect, it } from 'vitest'
import {
  applyPolicyEvidenceStrength,
  buildAssessmentExplanation,
  evaluateClaim,
  policyEvidenceStrengthOf,
  type ClaimObservation,
} from './assessment.js'
import type { Evidence } from './claim.js'
import type { Policy } from './policy.js'
import type { Decision } from './scoring.js'

const evidence = (id: string, stance: Evidence['stance']): Evidence => ({
  id,
  claimId: 'claim-1',
  checker: 'probe',
  checkerVersion: '1.0.0',
  stance,
  strength: 0.5,
  confidence: 0.5,
  source: 'test:probe',
  observedAt: '2026-01-01T00:00:00.000Z',
  ttlSeconds: 60,
  detail: {},
  signalId: null,
})

const decision = (verdict: Decision['verdict'], explanation: string): Decision => ({
  verdict,
  confidence: 0.8,
  hardRuleId: null,
  explanation,
})

describe('buildAssessmentExplanation', () => {
  it('usa o veredito como code e a mensagem da decisao', () => {
    const out = buildAssessmentExplanation(decision('CONFIRMED_COMMERCIAL', 'endereco ok'), [])
    expect(out.code).toBe('CONFIRMED_COMMERCIAL')
    expect(out.message).toBe('endereco ok')
  })

  it('separa evidencias por stance e ignora unknown', () => {
    const out = buildAssessmentExplanation(decision('INSUFFICIENT_EVIDENCE', 'sem prova'), [
      evidence('e1', 'supports'),
      evidence('e2', 'supports'),
      evidence('e3', 'contradicts'),
      evidence('e4', 'unknown'),
    ])
    expect(out.supportingEvidenceIds).toEqual(['e1', 'e2'])
    expect(out.contradictingEvidenceIds).toEqual(['e3'])
  })

  it('produz arrays vazios quando nao ha evidencias', () => {
    const out = buildAssessmentExplanation(decision('NOT_FOUND', 'cep inexistente'), [])
    expect(out.supportingEvidenceIds).toEqual([])
    expect(out.contradictingEvidenceIds).toEqual([])
  })
})

const NOW = new Date('2026-10-23T12:00:00.000Z')
const FISCAL = 'nf3e_verification'
const claimRef = { id: 'claim-1', type: 'business_registered_address' as const }

const policyWith = (evidenceCheckers: Policy['evidence_checkers']): Policy => ({
  version: '2026.14.1',
  weights: {},
  hard_rules: [],
  required_checkers: [],
  evidence_checkers: evidenceCheckers,
  credential_ttl_seconds: 3600,
  decision: { insufficient_band: [-0.2, 0.2], conflict_threshold: 0.45, confirmed_threshold: 0.35 },
})

const observation = (overrides: Partial<ClaimObservation> = {}): ClaimObservation => ({
  checker: FISCAL,
  checkerVersion: '1.0.0',
  stance: 'supports',
  strength: 0,
  confidence: 0,
  source: 'fiscal_nf3e',
  observedAt: NOW.toISOString(),
  ttlSeconds: 3600,
  detail: {},
  ...overrides,
})

const scoreOf = (policy: Policy, observations: readonly ClaimObservation[]): number =>
  evaluateClaim({ claim: claimRef, evidence: observations, policy, now: NOW }).score

describe('força de evidência definida pela policy (F3.1)', () => {
  it('aplica a força da policy somente a observações supports e configuradas', () => {
    const policy = policyWith({ [FISCAL]: { strength: 0.4, confidence: 0.8 } })

    expect(policyEvidenceStrengthOf(policy, observation())).toEqual({ strength: 0.4, confidence: 0.8 })
    for (const stance of ['contradicts', 'neutral', 'unknown'] as const) {
      expect(policyEvidenceStrengthOf(policy, observation({ stance }))).toBeNull()
    }
    expect(policyEvidenceStrengthOf(policy, observation({ checker: 'cnefe_match' }))).toBeNull()
    expect(policyEvidenceStrengthOf(policyWith({}), observation())).toBeNull()
  })

  it('preserva as observações não configuradas e as não positivas', () => {
    const policy = policyWith({ [FISCAL]: { strength: 0.4, confidence: 0.8 } })
    const untouched = observation({
      checker: 'cnefe_match',
      stance: 'supports',
      strength: 0.6,
      confidence: 0.9,
    })

    const [positive, negative, other] = applyPolicyEvidenceStrength(policy, [
      observation(),
      observation({ stance: 'contradicts' }),
      untouched,
    ])

    expect(positive).toMatchObject({ strength: 0.4, confidence: 0.8 })
    expect(negative).toMatchObject({ strength: 0, confidence: 0 })
    expect(other).toBe(untouched)
  })

  it('uma NF3e authentic com address.matches soma exatamente uma contribuição', () => {
    const policy = policyWith({ [FISCAL]: { strength: 0.4, confidence: 0.8 } })
    const fiscal = observation({
      detail: { verification: { document: 'authentic', address: 'matches', holder: 'matches' } },
    })

    // 0.4 × 0.8 = 0.32, aplicado uma única vez (document/address/holder não
    // geram três evidências independentes).
    expect(scoreOf(policy, [fiscal])).toBeCloseTo(0.32, 10)
  })

  it('não aplica força a estados neutros, contraditórios ou não configurados', () => {
    const policy = policyWith({ [FISCAL]: { strength: 0.4, confidence: 0.8 } })

    expect(scoreOf(policy, [observation({ stance: 'unknown' })])).toBe(0)
    expect(scoreOf(policy, [observation({ stance: 'contradicts' })])).toBe(0)
    expect(scoreOf(policy, [observation({ checker: 'cnefe_match' })])).toBe(0)
    expect(scoreOf(policyWith({}), [observation()])).toBe(0)
  })

  it('é no-op quando a policy não declara evidence_checkers', () => {
    const policy = policyWith({})
    const signals = [observation({ strength: 0.5, confidence: 0.9 })]
    expect(applyPolicyEvidenceStrength(policy, signals)[0]).toBe(signals[0])
    expect(scoreOf(policy, signals)).toBeCloseTo(0.45, 10)
  })
})
