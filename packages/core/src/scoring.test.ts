import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadPolicy } from './policy.js'
import { confidenceFrom, decide, weightedScore } from './scoring.js'
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

describe('policy loading', () => {
  it('carrega a politica versionada do YAML', () => {
    expect(policy.version).toBe('2026.11.1')
    expect(policy.hard_rules.length).toBe(3)
    expect(policy.weights['cotenancy']).toBe(1.3)
  })
})

describe('decide: tabela de casos', () => {
  it('FOREIGN curto-circuita por hard rule', () => {
    const out = decide({
      signals: [sig('country_check', 'neutral', 0.9, { verdict_hint: 'FOREIGN' })],
      score: 0,
      policy,
      now,
    })
    expect(out.verdict).toBe('FOREIGN')
    expect(out.hardRuleId).toBe('foreign-address')
    expect(out.confidence).toBe(0.9)
  })

  it('NOT_FOUND quando CEP nao existe (hard rule)', () => {
    const out = decide({
      signals: [sig('cep_consistency', 'contradicts', 0.7, { reason: 'cep_not_found' })],
      score: -0.5,
      policy,
      now,
    })
    expect(out.verdict).toBe('NOT_FOUND')
  })

  it('INCONSISTENT quando CNPJ baixado (hard rule)', () => {
    const out = decide({
      signals: [
        sig('registry_status', 'contradicts', 0.8, { situacao: 'baixada', verdict_hint: 'REGISTRY_DEFUNCT' }),
      ],
      score: -0.8,
      policy,
      now,
    })
    expect(out.verdict).toBe('INCONSISTENT')
  })

  it('SHARED_VIRTUAL por hint de cotenancy', () => {
    const out = decide({
      signals: [
        sig('document_integrity', 'supports', 0.5),
        sig('registry_status', 'supports', 0.5, { situacao: 'ativa' }),
        sig('cotenancy', 'neutral', 0.7, { verdict_hint: 'SHARED_VIRTUAL', active_cnpj_count: 12 }),
      ],
      score: 0.3,
      policy,
      now,
    })
    expect(out.verdict).toBe('SHARED_VIRTUAL')
  })

  it('OCCUPIED_BY_OTHER_ENTITY por hint de cotenancy', () => {
    const out = decide({
      signals: [
        sig('registry_status', 'supports', 0.5, { situacao: 'ativa' }),
        sig('cnefe_match', 'supports', 0.6, { match: 'exact_number' }),
        sig('cotenancy', 'contradicts', 0.7, {
          verdict_hint: 'OCCUPIED_BY_OTHER_ENTITY',
          other_names: ['Padaria X'],
        }),
      ],
      score: 0.2,
      policy,
      now,
    })
    expect(out.verdict).toBe('OCCUPIED_BY_OTHER_ENTITY')
    expect(out.explanation).toContain('Padaria X')
  })

  it('RESIDENTIAL por hint combinado de cnae/cnefe', () => {
    const out = decide({
      signals: [
        sig('registry_status', 'supports', 0.5, { situacao: 'ativa' }),
        sig('cnefe_match', 'neutral', 0.3, { residential_hint: true }),
        sig('cnae_vs_location', 'supports', 0.4, {
          verdict_hint: 'RESIDENTIAL',
          categoria: 'RESIDENTIAL_COMPATIBLE',
        }),
      ],
      score: 0.2,
      policy,
      now,
    })
    expect(out.verdict).toBe('RESIDENTIAL')
  })

  it('CONFIRMED_COMMERCIAL com score acima do limiar', () => {
    const signals: readonly Signal[] = [
      sig('document_integrity', 'supports', 0.5),
      sig('registry_status', 'supports', 0.5, { situacao: 'ativa' }),
      sig('country_check', 'supports', 0.2, { country: 'BR' }),
      sig('cep_consistency', 'supports', 0.6, { cep: '01310100' }),
      sig('cnefe_match', 'supports', 0.6, { match: 'exact_number' }),
      sig('cotenancy', 'supports', 0.4, { other_active_cnpjs: 0 }),
    ]
    const score = weightedScore(signals, policy, now)
    expect(score).toBeGreaterThanOrEqual(policy.decision.confirmed_threshold)
    const out = decide({ signals, score, policy, now })
    expect(out.verdict).toBe('CONFIRMED_COMMERCIAL')
    expect(out.confidence).toBeGreaterThan(0.5)
  })

  it('INCONSISTENT quando suporte e contradicao fortes simultaneos', () => {
    const signals: readonly Signal[] = [
      sig('document_integrity', 'supports', 0.5),
      sig('registry_status', 'supports', 0.5, { situacao: 'ativa' }),
      sig('cnefe_match', 'supports', 0.6, { match: 'exact_number' }),
      sig('cep_consistency', 'contradicts', 0.8, { reason: 'uf_mismatch' }),
      sig('cotenancy', 'contradicts', 0.7, { other_active_cnpjs: 2 }),
    ]
    const out = decide({ signals, score: 0, policy, now })
    expect(out.verdict).toBe('INCONSISTENT')
  })

  it('INSUFFICIENT_EVIDENCE quando cobertura baixa', () => {
    const signals: readonly Signal[] = [
      sig('document_integrity', 'supports', 0.5),
      sig('registry_status', 'unknown', 0, { reason: 'not_in_registry' }),
      sig('cnefe_match', 'unknown', 0, { match: 'none' }),
      sig('cotenancy', 'unknown', 0, { reason: 'no_profile' }),
    ]
    const out = decide({ signals, score: 0.2, policy, now })
    expect(out.verdict).toBe('INSUFFICIENT_EVIDENCE')
    expect(out.confidence).toBeLessThan(0.6)
  })
})

describe('confidenceFrom', () => {
  it('cresce com cobertura e concordancia', () => {
    const low = confidenceFrom([sig('document_integrity', 'supports', 0.5)], policy, now)
    const high = confidenceFrom(
      [
        sig('document_integrity', 'supports', 0.5),
        sig('registry_status', 'supports', 0.5),
        sig('country_check', 'supports', 0.2),
        sig('cep_consistency', 'supports', 0.6),
        sig('cnefe_match', 'supports', 0.6),
        sig('cotenancy', 'supports', 0.4),
      ],
      policy,
      now,
    )
    expect(high).toBeGreaterThan(low)
  })

  it('decay zera sinais expirados', () => {
    const expired: Signal = {
      ...sig('document_integrity', 'supports', 0.5),
      observedAt: '2020-01-01T00:00:00Z',
      ttlSeconds: 3600,
    }
    const s = weightedScore([expired], policy, now)
    expect(s).toBe(0)
  })
})
