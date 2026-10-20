import type { Db } from '@comprova/db'
import { withTenant } from '@comprova/db'
import {
  buildAssessmentExplanation,
  decide,
  evaluateClaim,
  evidenceSetHashOfObservations,
  observationFromSignal,
  SCORER_VERSION,
  weightedScore,
  type Checker,
  type ClaimType,
  type Clock,
  type Policy,
  type Signal,
  type SignalCacheReader,
  type SubjectType,
  type Verdict,
} from '@comprova/core'
import type { DeepEnrichInput, DeepEnrichResult } from './deep-enrich.schema.js'
import {
  emitOutcomeEvents,
  linkClaimEvidence,
  persistFreshSignals,
  readEvidenceSet,
  resolveClaimId,
  updateValidationOutcome,
} from './deep-enrich.persistence.js'
import { runCheckersSequentially, signalFromRow } from './deep-enrich.signals.js'
import { buildCheckContext, loadValidationState } from './deep-enrich.state.js'

export interface DeepEnrichDeps {
  readonly db: Db
  readonly t1Checkers: readonly Checker[]
  readonly t2Checkers?: readonly Checker[]
  readonly policy: Policy
  /**
   * Digest do CONTEÚDO efetivo da policy carregada (`policyHashOf`). Comparar
   * só o veredito e o conjunto de evidências não detecta uma mudança de policy
   * que preserve as evidências, mas mude a conclusão. A3/ADR-0030.
   */
  readonly policyHash: string
  readonly clock: Clock
  readonly signalCache?: SignalCacheReader
}

const AMBIGUITY_THRESHOLD = 0.55

const isAmbiguous = (decision: { readonly verdict: Verdict; readonly confidence: number }): boolean =>
  decision.verdict === 'INSUFFICIENT_EVIDENCE' || decision.confidence < AMBIGUITY_THRESHOLD

const claimTypeOf = (docType: string): ClaimType =>
  docType === 'CNPJ' ? 'business_registered_address' : 'address_exists'

const subjectTypeOf = (docType: string): SubjectType => (docType === 'CNPJ' ? 'organization' : 'person')

export const deepEnrich = async (deps: DeepEnrichDeps, input: DeepEnrichInput): Promise<DeepEnrichResult> => {
  /**
   * Instante de AVALIAÇÃO: referência única dos cálculos (freshness/score/
   * decisão, em T1 e no resultado final) e do TTL dos sinais em cache. Os
   * verificadores podem levar tempo, então este instante NÃO é o de conclusão —
   * `completed_at` é lido separadamente onde o resultado terminal fica pronto
   * (ver `completedAt` em `updateValidationOutcome`).
   */
  const evaluatedAt = deps.clock.now()
  const state = await loadValidationState(deps.db, input.tenantId, input.validationId)
  const signals = state.priorSignals.map(signalFromRow)

  const ctx = buildCheckContext({
    validation: state.validation,
    subject: state.subject,
    addressRow: state.addressRow,
    priorSignals: signals,
    clock: deps.clock,
  })

  const newSignals = await runCheckersSequentially({
    checkers: deps.t1Checkers,
    prior: signals,
    ctx,
    docType: state.subject.docType,
    addressId: state.validation.addressId,
    ...(deps.signalCache !== undefined ? { signalCache: deps.signalCache } : {}),
  })

  const signalsAfterT1: readonly Signal[] = [...signals, ...newSignals]
  const scoreAfterT1 = weightedScore(signalsAfterT1, deps.policy, evaluatedAt)
  const decisionAfterT1 = decide({
    signals: signalsAfterT1,
    score: scoreAfterT1,
    policy: deps.policy,
    now: evaluatedAt,
  })
  const maxTier = input.maxTier ?? 2
  const t2Signals =
    isAmbiguous(decisionAfterT1) && maxTier >= 2 && deps.t2Checkers !== undefined
      ? await runCheckersSequentially({
          checkers: deps.t2Checkers,
          prior: signalsAfterT1,
          ctx,
          docType: state.subject.docType,
          addressId: state.validation.addressId,
          ...(deps.signalCache !== undefined ? { signalCache: deps.signalCache } : {}),
        })
      : []

  const claimType = claimTypeOf(state.subject.docType)
  const subjectType = subjectTypeOf(state.subject.docType)

  const outcome = await withTenant(deps.db, input.tenantId, async (tx) => {
    const existingCheckerIds = new Set(signals.map((s) => `${s.checkerId}@${s.checkerVersion}`))
    const freshSignals = [...newSignals, ...t2Signals].filter(
      (s) => !existingCheckerIds.has(`${s.checkerId}@${s.checkerVersion}`),
    )

    const claimId = await resolveClaimId(tx, {
      tenantId: input.tenantId,
      validationId: input.validationId,
      subjectId: state.validation.subjectId,
      addressId: state.validation.addressId,
      claimType,
      subjectType,
    })

    const { score, decision } = evaluateClaim({
      claim: { id: claimId ?? '', type: claimType },
      evidence: [...signalsAfterT1, ...t2Signals].map(observationFromSignal),
      policy: deps.policy,
      now: evaluatedAt,
    })
    const stillPartial = isAmbiguous(decision)

    const freshSignalIds = await persistFreshSignals(tx, {
      validationId: input.validationId,
      addressId: state.validation.addressId,
      signals: freshSignals,
      now: evaluatedAt,
    })

    await linkClaimEvidence(tx, {
      tenantId: input.tenantId,
      claimId,
      priorSignals: state.priorSignals,
      freshSignals,
      freshSignalIds,
    })

    const evidenceRows = await readEvidenceSet(tx, claimId)
    const explanationDetail = buildAssessmentExplanation(
      decision,
      evidenceRows.map((row) => ({ id: row.id, stance: row.stance })),
    )
    const evidenceSetHash = evidenceSetHashOfObservations(evidenceRows)

    /**
     * Instante de CONCLUSÃO (`completed_at`) — ADR-0024 §5. É o instante em que a
     * validação se tornou terminal PELA PRIMEIRA VEZ, não o horário da última
     * execução do worker:
     *
     * - `partial` não conclui: `updateValidationOutcome` mantém `completed_at`
     *   NULL (e uma conclusão anterior fica retraída junto com o status);
     * - replay que REPRODUZ o resultado terminal persistido (mesmo veredito,
     *   mesmo conjunto de evidências, mesma policy e mesmo scorer) PRESERVA o
     *   `completed_at` original: reexecutar o worker não é reconcluir, e mover o
     *   instante mudaria o `validFrom` de credenciais emitidas depois, sem
     *   conclusão nova;
     * - resultado terminal NOVO (veredito, evidências, policy ou scorer
     *   diferentes — a primeira conclusão de uma validação `queued`/`partial`,
     *   ou um registro legado concluído sem timestamp) grava o instante real,
     *   lido aqui, depois de todos os verificadores (T1/T2), dos cálculos e do
     *   resultado final.
     *
     * A comparação usa veredito + hash do conjunto de evidências + `policy_hash`
     * + `scorer_version` (valores exatos); `score`/`confidence` ficam de fora
     * porque são colunas `real` (float4) e a comparação de float não é
     * confiável. Sem os dois últimos, uma policy nova que reordenasse/alterasse
     * a conclusão sobre as MESMAS evidências seria tratada como replay e
     * manteria um `completed_at` (e um `validFrom`) que já não corresponde à
     * conclusão vigente.
     */
    const previous = state.validation
    const completedAt =
      // Replay do mesmo resultado terminal: preserva o `completed_at` original.
      previous.status === 'completed' &&
      previous.completedAt !== null &&
      !stillPartial &&
      decision.verdict === previous.verdict &&
      evidenceSetHash === previous.evidenceSetHash &&
      previous.policyHash === deps.policyHash &&
      previous.scorerVersion === SCORER_VERSION
        ? previous.completedAt
        : deps.clock.now()

    await updateValidationOutcome(tx, {
      validationId: input.validationId,
      stillPartial,
      verdict: decision.verdict,
      score,
      confidence: decision.confidence,
      evidenceSetHash,
      explanation: {
        summary: decision.explanation,
        code: explanationDetail.code,
        supporting_evidence: explanationDetail.supportingEvidenceIds,
        contradicting_evidence: explanationDetail.contradictingEvidenceIds,
      },
      completedAt,
    })

    await emitOutcomeEvents(tx, {
      tenantId: input.tenantId,
      validationId: input.validationId,
      claimId,
      claimType,
      stillPartial,
      verdict: decision.verdict,
    })

    return { score, decision, stillPartial }
  })

  return {
    status: outcome.stillPartial ? 'partial' : 'completed',
    verdict: outcome.decision.verdict,
    confidence: outcome.decision.confidence,
    score: Math.tanh(outcome.score),
    explanation: outcome.decision.explanation,
    newSignals: newSignals.length + t2Signals.length,
    t2Signals: t2Signals.length,
  }
}
