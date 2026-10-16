import { describe, expect, it } from 'vitest'
import { buildAssessmentExplanation } from './assessment.js'
import type { Evidence } from './claim.js'
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
