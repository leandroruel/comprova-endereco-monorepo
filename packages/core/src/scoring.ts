import type { Signal, Stance } from './types.js'
import type { Policy, Verdict } from './policy.js'

export const STANCE_SIGN: Readonly<Record<Stance, number>> = {
  supports: 1,
  neutral: 0,
  contradicts: -1,
  unknown: 0,
}

export const decayOf = (signal: Signal, now: Date): number => {
  const ageSeconds = Math.max(0, (now.getTime() - Date.parse(signal.observedAt)) / 1000)
  if (signal.ttlSeconds <= 0) return 1
  return ageSeconds >= signal.ttlSeconds ? 0 : Math.max(0.1, 1 - ageSeconds / signal.ttlSeconds)
}

export const weightedScore = (signals: readonly Signal[], policy: Policy, now: Date): number =>
  signals.reduce((acc, s) => {
    const weight = policy.weights[s.checkerId] ?? 1
    return acc + STANCE_SIGN[s.stance] * s.strength * s.confidence * decayOf(s, now) * weight
  }, 0)

export const confidenceFrom = (signals: readonly Signal[], policy: Policy, now: Date): number => {
  const required = policy.required_checkers
  const answered = required.filter((id) => signals.some((s) => s.checkerId === id && s.stance !== 'unknown'))
  const coverage = required.length === 0 ? 1 : answered.length / required.length
  const magnitude = (stance: Stance): number =>
    signals
      .filter((s) => s.stance === stance)
      .reduce((acc, s) => acc + s.strength * s.confidence * decayOf(s, now), 0)
  const positive = magnitude('supports')
  const negative = magnitude('contradicts')
  const total = positive + negative
  const rawAgreement = total === 0 ? 0 : Math.abs(positive - negative) / total
  return Math.min(0.99, Math.max(0, 0.35 + 0.4 * coverage + 0.25 * rawAgreement * coverage))
}

export interface DecisionInput {
  readonly signals: readonly Signal[]
  readonly score: number
  readonly policy: Policy
  readonly now: Date
}

export interface Decision {
  readonly verdict: Verdict
  readonly confidence: number
  readonly hardRuleId: string | null
  readonly explanation: string
}

const detailMatch = (
  signal: Signal,
  rule: { readonly when_detail_equals: Record<string, string | number | boolean> },
): boolean =>
  Object.entries(rule.when_detail_equals).every(([key, expected]) => signal.detail[key] === expected)

const hintOf = (signals: readonly Signal[], hint: string): Signal | null =>
  signals.find((s) => s.detail['verdict_hint'] === hint) ?? null

export const decide = (input: DecisionInput): Decision => {
  const { signals, score, policy, now } = input

  const hardRule = policy.hard_rules.find(
    (rule) => signals.find((s) => s.checkerId === rule.when_checker && detailMatch(s, rule)) !== undefined,
  )
  if (hardRule !== undefined) {
    return {
      verdict: hardRule.verdict,
      confidence: hardRule.confidence,
      hardRuleId: hardRule.id,
      explanation: hardRuleExplanation(hardRule.verdict),
    }
  }

  const positive = weightedScore(
    signals.filter((s) => s.stance === 'supports'),
    policy,
    now,
  )
  const negative = weightedScore(
    signals.filter((s) => s.stance === 'contradicts'),
    policy,
    now,
  )
  if (hintOf(signals, 'SHARED_VIRTUAL') !== null) {
    return {
      verdict: 'SHARED_VIRTUAL',
      confidence: Math.min(0.9, Math.max(0.7, confidenceFrom(signals, policy, now))),
      hardRuleId: null,
      explanation:
        'Endereco compartilhado por muitos CNPJs ativos de setores variados (escritorio contabil, coworking ou similar).',
    }
  }

  if (hintOf(signals, 'OCCUPIED_BY_OTHER_ENTITY') !== null) {
    const others = hintOf(signals, 'OCCUPIED_BY_OTHER_ENTITY')?.detail['other_names']
    const names = Array.isArray(others) ? others.join(', ') : null
    return {
      verdict: 'OCCUPIED_BY_OTHER_ENTITY',
      confidence: Math.min(0.9, Math.max(0.6, confidenceFrom(signals, policy, now))),
      hardRuleId: null,
      explanation:
        names === null
          ? 'Ha outro estabelecimento ativo no mesmo imovel sem indicio de relacao com o consultado.'
          : `Ha outro estabelecimento ativo no mesmo imovel (${names}) sem indicio de relacao com o consultado.`,
    }
  }

  if (hintOf(signals, 'RESIDENTIAL') !== null) {
    return {
      verdict: 'RESIDENTIAL',
      confidence: Math.min(0.85, Math.max(0.55, confidenceFrom(signals, policy, now))),
      hardRuleId: null,
      explanation:
        'Endereco aparenta ser residencia comum; atividade compativel com MEI/profissional (informacional, nao condenacao).',
    }
  }

  if (positive >= policy.decision.conflict_threshold && negative <= -policy.decision.conflict_threshold) {
    return {
      verdict: 'INCONSISTENT',
      confidence: confidenceFrom(signals, policy, now),
      hardRuleId: null,
      explanation: 'Sinais fortes se contradizem: ha evidencia relevante a favor e contra ao mesmo tempo.',
    }
  }

  const addressConfirmed =
    signals.find(
      (s) => (s.checkerId === 'cnefe_match' || s.checkerId === 'cep_consistency') && s.stance === 'supports',
    ) !== undefined
  if (score >= policy.decision.confirmed_threshold && addressConfirmed) {
    return {
      verdict: 'CONFIRMED_COMMERCIAL',
      confidence: confidenceFrom(signals, policy, now),
      hardRuleId: null,
      explanation: 'Endereco existe e e compativel com a atividade comercial do CNPJ consultado.',
    }
  }

  return {
    verdict: 'INSUFFICIENT_EVIDENCE',
    confidence: confidenceFrom(signals, policy, now),
    hardRuleId: null,
    explanation: 'Evidencia insuficiente para concluir; ausencia de evidencia nao e evidencia de ausencia.',
  }
}

const hardRuleExplanation = (verdict: Verdict): string => {
  const explanations: Record<Verdict, string> = {
    FOREIGN: 'Endereco no exterior registrado no cadastro da Receita Federal.',
    NOT_FOUND: 'CEP informado nao existe na base de CEPs de referencia.',
    INCONSISTENT: 'CNPJ com situacao cadastral baixada ou inapta no endereco informado.',
    SHARED_VIRTUAL: 'Endereco compartilhado por muitos CNPJs ativos.',
    OCCUPIED_BY_OTHER_ENTITY: 'Outro estabelecimento ativo no mesmo imovel.',
    RESIDENTIAL: 'Endereco aparenta ser residencia comum.',
    CONFIRMED_COMMERCIAL: 'Endereco comercial confirmado.',
    INSUFFICIENT_EVIDENCE: 'Evidencia insuficiente.',
  }
  return explanations[verdict]
}
