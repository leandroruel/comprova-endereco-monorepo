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
 * Avalia um claim a partir das suas evidências contra uma policy.
 *
 * Implementação inicial: reconstrói os signals a partir das evidências e delega
 * para `weightedScore` + `decide`. Como o stance é preservado fielmente, o
 * resultado é idêntico ao pipeline anterior (no-op semântico).
 */
export const evaluateClaim = (input: EvaluateClaimInput): ClaimEvaluation => {
  const signals: readonly Signal[] = input.evidence.map((e) => ({
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
