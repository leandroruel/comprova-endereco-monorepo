import type { AssessmentExplanation, Claim, Evidence } from './claim.js'
import type { Policy } from './policy.js'
import { decide, weightedScore, type Decision } from './scoring.js'
import type { Signal, Stance } from './types.js'

/** Forma mínima aceita pelo builder de explicação: identidade + posição. */
export type EvidenceLike = Pick<Evidence, 'id' | 'stance'>

/**
 * Observação de um checker usada para avaliar um claim. Espelha o `stance` do
 * signal fielmente (inclui `neutral`) para que o scoring seja idêntico ao
 * pipeline de signals.
 */
export interface ClaimObservation {
  readonly checker: string
  readonly checkerVersion: string
  readonly stance: Stance
  readonly strength: number
  readonly confidence: number
  readonly source: string
  readonly observedAt: string
  readonly ttlSeconds: number
  readonly detail: Record<string, unknown>
}

export interface EvaluateClaimInput {
  /** Claim sendo avaliado (identidade explícita da afirmação). */
  readonly claim: Pick<Claim, 'id' | 'type'>
  readonly evidence: readonly ClaimObservation[]
  readonly policy: Policy
  readonly now: Date
}

export interface ClaimEvaluation {
  readonly score: number
  readonly decision: Decision
}

/**
 * Força que a policy atribui a uma observação, ou `null` quando a policy não
 * configura o checker ou a observação não é uma posição positiva.
 *
 * F3.1: apenas `supports` recebe força. `contradicts` (`differs`),
 * `not_extracted` e estados neutros/indisponíveis permanecem sem força — a
 * indisponibilidade nunca vira evidência negativa e `differs` não vira hard
 * rejection. A decisão de força é da policy, não do adapter.
 */
export const policyEvidenceStrengthOf = (
  policy: Policy,
  observation: Pick<ClaimObservation, 'checker' | 'stance'>,
): { readonly strength: number; readonly confidence: number } | null => {
  const configured = policy.evidence_checkers[observation.checker]
  if (configured === undefined) return null
  if (observation.stance !== 'supports') return null
  return { strength: configured.strength, confidence: configured.confidence }
}

/**
 * Aplica a força definida na policy às observações elegíveis. Uma evidência
 * continua sendo **uma** observação/checker — não há uma linha por dimensão,
 * então não existe dupla contagem de documento/endereço/titular.
 */
export const applyPolicyEvidenceStrength = (
  policy: Policy,
  observations: readonly ClaimObservation[],
): readonly ClaimObservation[] =>
  observations.map((observation) => {
    const force = policyEvidenceStrengthOf(policy, observation)
    return force === null ? observation : { ...observation, ...force }
  })

/**
 * Avalia um claim a partir das suas evidências contra uma policy.
 *
 * Implementação inicial: reconstrói os signals a partir das evidências e delega
 * para `weightedScore` + `decide`. Como o stance é preservado fielmente, o
 * resultado é idêntico ao pipeline anterior (no-op semântico).
 *
 * A única transformação antes do scoring é a força de fonte externa definida na
 * policy (`evidence_checkers`); sem configuração, o comportamento é idêntico ao
 * pipeline de signals.
 */
export const evaluateClaim = (input: EvaluateClaimInput): ClaimEvaluation => {
  const signals: readonly Signal[] = applyPolicyEvidenceStrength(input.policy, input.evidence).map((e) => ({
    checkerId: e.checker,
    checkerVersion: e.checkerVersion,
    stance: e.stance,
    strength: e.strength,
    confidence: e.confidence,
    source: e.source,
    observedAt: e.observedAt,
    ttlSeconds: e.ttlSeconds,
    detail: e.detail,
  }))
  const score = weightedScore(signals, input.policy, input.now)
  return { score, decision: decide({ signals, score, policy: input.policy, now: input.now }) }
}

/** Converte um signal bruto na observação usada por `evaluateClaim`. */
export const observationFromSignal = (signal: Signal): ClaimObservation => ({
  checker: signal.checkerId,
  checkerVersion: signal.checkerVersion,
  stance: signal.stance,
  strength: signal.strength,
  confidence: signal.confidence,
  source: signal.source,
  observedAt: signal.observedAt,
  ttlSeconds: signal.ttlSeconds,
  detail: signal.detail,
})

/**
 * Constrói a explicação estruturada de um assessment a partir da decisão
 * (verdict + mensagem) e das evidências que a sustentam/contradizem.
 *
 * O `code` é o veredito (ex.: `INSUFFICIENT_EVIDENCE`), permitindo que
 * consumidores programáticos reajam sem parsear a mensagem em linguagem natural.
 */
export const buildAssessmentExplanation = (
  decision: Decision,
  evidence: readonly EvidenceLike[],
): AssessmentExplanation => ({
  code: decision.verdict,
  message: decision.explanation,
  supportingEvidenceIds: evidence.filter((e) => e.stance === 'supports').map((e) => e.id),
  contradictingEvidenceIds: evidence.filter((e) => e.stance === 'contradicts').map((e) => e.id),
})
