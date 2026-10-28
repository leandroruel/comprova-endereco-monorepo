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
    expect(out.explanation).toBe(
      'Não foi possível confirmar o endereço porque o CNPJ não consta no cadastro da Receita Federal.',
    )
    expect(out.explanation).not.toContain('ausencia de evidencia nao e evidencia de ausencia')
  })

  it('INSUFFICIENT_EVIDENCE com comprovante sem endereco extraido', () => {
    const signals: readonly Signal[] = [
      sig('document_integrity', 'supports', 0.5),
      sig('document_upload_verification', 'unknown', 0, {
        verification: { address: 'not_extracted', document: 'inconclusive' },
      }),
      sig('cnefe_match', 'unknown', 0, { match: 'none' }),
    ]
    const out = decide({ signals, score: 0.2, policy, now })
    expect(out.verdict).toBe('INSUFFICIENT_EVIDENCE')
    expect(out.explanation).toBe(
      'Não foi possível confirmar o endereço porque o comprovante não apresentou dados suficientes para comparação.',
    )
  })

  it('INSUFFICIENT_EVIDENCE com fonte fiscal nao suportada', () => {
    const signals: readonly Signal[] = [
      sig('document_integrity', 'supports', 0.5),
      sig('nf3e_verification', 'unknown', 0, {
        verification: { document: 'unsupported', address: 'not_extracted' },
      }),
    ]
    const out = decide({ signals, score: 0.2, policy, now })
    expect(out.verdict).toBe('INSUFFICIENT_EVIDENCE')
    expect(out.explanation).toBe(
      'Não foi possível confirmar a autenticidade do documento porque a fonte fiscal ainda não é suportada.',
    )
  })

  it('INSUFFICIENT_EVIDENCE com CEP ausente', () => {
    const signals: readonly Signal[] = [
      sig('document_integrity', 'supports', 0.5),
      sig('registry_status', 'unknown', 0, { reason: 'not_in_registry' }),
      sig('cep_consistency', 'unknown', 0, { reason: 'cep_missing' }),
      sig('cnefe_match', 'unknown', 0, { match: 'none' }),
    ]
    const out = decide({ signals, score: 0.2, policy, now })
    expect(out.verdict).toBe('INSUFFICIENT_EVIDENCE')
    expect(out.explanation).toBe('Não foi possível confirmar o endereço porque o CEP não foi informado.')
  })

  it('INSUFFICIENT_EVIDENCE com CEP inexistente na base local', () => {
    const signals: readonly Signal[] = [
      sig('document_integrity', 'supports', 0.5),
      sig('registry_status', 'unknown', 0, { reason: 'not_in_registry' }),
      sig('cep_consistency', 'unknown', 0, { reason: 'cep_not_in_local_db' }),
      sig('cnefe_match', 'unknown', 0, { match: 'none' }),
    ]
    const out = decide({ signals, score: 0.2, policy, now })
    expect(out.verdict).toBe('INSUFFICIENT_EVIDENCE')
    expect(out.explanation).toBe(
      'Não foi possível confirmar o endereço porque o CEP informado não consta na base de referência.',
    )
  })

  it('INSUFFICIENT_EVIDENCE com endereco nao resolvido no CNEFE', () => {
    const signals: readonly Signal[] = [
      sig('document_integrity', 'supports', 0.5),
      sig('registry_status', 'unknown', 0, { reason: 'not_in_registry' }),
      sig('cep_consistency', 'unknown', 0, { reason: 'cep_missing' }),
      sig('cnefe_match', 'unknown', 0, { reason: 'address_not_resolved' }),
    ]
    const out = decide({ signals, score: 0.2, policy, now })
    expect(out.verdict).toBe('INSUFFICIENT_EVIDENCE')
    expect(out.explanation).toBe(
      'Não foi possível confirmar o endereço porque o endereço informado não pôde ser localizado no CNEFE.',
    )
  })

  it('INSUFFICIENT_EVIDENCE sem causa reconhecível usa fallback generico', () => {
    const signals: readonly Signal[] = [
      sig('document_integrity', 'supports', 0.5),
      sig('registry_status', 'unknown', 0, { reason: 'no_profile' }),
      sig('cnefe_match', 'unknown', 0, { match: 'none' }),
    ]
    const out = decide({ signals, score: 0.2, policy, now })
    expect(out.verdict).toBe('INSUFFICIENT_EVIDENCE')
    expect(out.explanation).toBe('Não foi possível confirmar o endereço com as evidências disponíveis.')
  })

  it('vereditos existentes nao mudam a explanation', () => {
    const confirmed: readonly Signal[] = [
      sig('document_integrity', 'supports', 0.5),
      sig('registry_status', 'supports', 0.5, { situacao: 'ativa' }),
      sig('country_check', 'supports', 0.2, { country: 'BR' }),
      sig('cep_consistency', 'supports', 0.6, { cep: '01310100' }),
      sig('cnefe_match', 'supports', 0.6, { match: 'exact_number' }),
    ]
    const score = weightedScore(confirmed, policy, now)
    const out = decide({ signals: confirmed, score, policy, now })
    expect(out.verdict).toBe('CONFIRMED_COMMERCIAL')
    expect(out.explanation).toBe(
      'Endereco existe e e compativel com a atividade comercial do CNPJ consultado.',
    )
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
