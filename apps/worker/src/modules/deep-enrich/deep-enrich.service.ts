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
  type ClaimObservation,
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
  readStandaloneEvidenceSet,
  resolveClaimId,
  supersedeIssuedCredentials,
  updateValidationOutcome,
  type StandaloneEvidenceRow,
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
   * que preserve as evidências, mas mude a conclusão.
   * A3/ADR-0024, Revisão pós-PR #5.
   */
  readonly policyHash: string
  readonly clock: Clock
  readonly signalCache?: SignalCacheReader
}

const AMBIGUITY_THRESHOLD = 0.55

const isAmbiguous = (decision: { readonly verdict: Verdict; readonly confidence: number }): boolean =>
  decision.verdict === 'INSUFFICIENT_EVIDENCE' || decision.confidence < AMBIGUITY_THRESHOLD

/**
 * Entrada do assessment: signals legados (com stance de 4 valores, preservando a
 * fidelidade do ADR-0016) mais observações que não têm `signal` — recibo de
 * intake (F1.1), verificação do documento enviado (F1.3) e consulta fiscal (F2).
 * Estas últimas nunca tiveram `neutral` persistido, então entram direto de
 * `claim_evidence`; as ligadas a `signal` ficam de fora para não duplicar o
 * mesmo fato no score.
 */
export const assessmentObservationsOf = (
  signals: readonly Signal[],
  standalone: readonly StandaloneEvidenceRow[],
): readonly ClaimObservation[] => [
  ...signals.map(observationFromSignal),
  ...standalone.map((row) => ({
    checker: row.checker,
    checkerVersion: row.checkerVersion,
    stance: row.stance,
    strength: row.strength,
    confidence: row.confidence,
    source: row.source,
    observedAt: row.observedAt.toISOString(),
    ttlSeconds: row.ttlSeconds,
    detail: row.detail,
  })),
]

/**
 * Para scoring, evita que o mesmo documento fiscal seja contado mais de uma vez
 * por versões diferentes do adapter. A unicidade de `claim_evidence` é
 * `(claim, source, checker, checker_version)`, então um bump de adapter insere
 * uma linha nova para o mesmo documento: sem esta dedup, cada versão com
 * `stance = supports` somaria `0.4 × 0.8 = 0.32`.
 *
 * A dedup é restrita ao caso fiscal/NF3e (`source = fiscal_nf3e`,
 * `checker = nf3e_verification`). Evidências não fiscais (intake F1.1,
 * uploaded_document F1.3) seguem inalteradas.
 *
 * Todas as linhas históricas são mantidas na tabela (auditoria/explicação usam
 * `readEvidenceSet`, que não é dedupada). Para o score, apenas a observação
 * canônica de cada documento contribui: a mais recente, já que
 * `readStandaloneEvidenceSet` retorna ordenada por `observedAt DESC,
 * createdAt DESC`. A versão mais recente prevalece mesmo quando o stance muda
 * entre versões (ex.: v1 `supports`, v2 `inconclusive` → só v2 entra no score,
 * sem força positiva). Linhas sem hash de documento seguem intactas.
 */
const docRefHashOf = (row: StandaloneEvidenceRow): string | null => {
  const detail = row.detail as Record<string, unknown> | undefined
  const verification = detail?.verification as Record<string, unknown> | undefined
  const docRef = verification?.document_ref_hash
  return typeof docRef === 'string' ? docRef : null
}

const isFiscalNf3e = (row: StandaloneEvidenceRow): boolean =>
  row.source === 'fiscal_nf3e' && row.checker === 'nf3e_verification'

export const canonicalStandaloneEvidence = (
  rows: readonly StandaloneEvidenceRow[],
): readonly StandaloneEvidenceRow[] => {
  const seenFiscalDoc = new Set<string>()
  const out: StandaloneEvidenceRow[] = []
  for (const row of rows) {
    // Só fiscal/NF3e entra na dedup de versão; não-fiscais passam direto.
    if (isFiscalNf3e(row)) {
      const docHash = docRefHashOf(row)
      if (docHash !== null) {
        if (seenFiscalDoc.has(docHash)) continue
        seenFiscalDoc.add(docHash)
      }
    }
    out.push(row)
  }
  return out
}

const claimTypeOf = (docType: string): ClaimType =>
  docType === 'CNPJ' ? 'business_registered_address' : 'address_exists'

const subjectTypeOf = (docType: string): SubjectType => (docType === 'CNPJ' ? 'organization' : 'person')

export interface PriorCredentialOutcome {
  readonly status: string
  readonly verdict: Verdict | null
  readonly evidenceSetHash: string | null
  readonly policyHash: string | null
  readonly scorerVersion: string | null
}

export interface NextCredentialOutcome {
  readonly stillPartial: boolean
  readonly verdict: Verdict
  readonly evidenceSetHash: string
  readonly policyHash: string
  readonly scorerVersion: string
}

/**
 * C1/ADR-0024, Revisão pós-PR #5: uma credencial já emitida deixa de
 * representar a conclusão vigente quando o deep path produz OUTRA conclusão —
 * veredito, conjunto de evidências, policy ou scorer diferentes — ou quando a
 * validation deixa de ser terminal (`partial`). Replay idêntico NÃO revoga.
 *
 * `previous.status === 'completed'` é o portão: só existe credencial emitível
 * (e, portanto, possivelmente emitida) depois de uma conclusão. Se não havia
 * conclusão, não há status a revogar e `supersedeIssuedCredentials` seria no-op
 * de qualquer forma, mas evitamos a consulta.
 */
export const outcomeSupersedesCredentials = (
  previous: PriorCredentialOutcome,
  next: NextCredentialOutcome,
): boolean => {
  if (previous.status !== 'completed') return false
  if (next.stillPartial) return true
  return (
    previous.verdict !== next.verdict ||
    previous.evidenceSetHash !== next.evidenceSetHash ||
    previous.policyHash !== next.policyHash ||
    previous.scorerVersion !== next.scorerVersion
  )
}

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

    // F1.3/F2: observações sem `signal` já persistidas no claim participam da
    // avaliação existente. Com `strength`/`confidence` neutros (0), o score e o
    // veredito não mudam; a F3 decide peso/força. Versões repetidas de um mesmo
    // documento fiscal são dedupadas para scoring (uma linha `supports` por
    // `document_ref_hash`) para não somar força duas vezes.
    const standaloneEvidence = canonicalStandaloneEvidence(await readStandaloneEvidenceSet(tx, claimId))
    const { score, decision } = evaluateClaim({
      claim: { id: claimId ?? '', type: claimType },
      evidence: assessmentObservationsOf([...signalsAfterT1, ...t2Signals], standaloneEvidence),
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
     * A comparação usa veredito + hash do conjunto de evidências + policy/scorer
     * da ÚLTIMA AVALIAÇÃO (`last_evaluated_*`, com fallback para o binding
     * imutável em linhas legadas); `score`/`confidence` ficam de fora porque são
     * colunas `real` (float4) e a comparação de float não é confiável. Sem os
     * dois últimos, uma policy nova que reordenasse/alterasse a conclusão sobre
     * as MESMAS evidências seria tratada como replay e manteria um
     * `completed_at` (e um `validFrom`) que já não corresponde à conclusão
     * vigente. Comparar só o binding imutável faria o contrário: toda reexecução
     * sob a policy nova pareceria uma conclusão nova.
     */
    const previous = state.validation
    const previousOutcome = {
      ...previous,
      policyHash: previous.lastEvaluatedPolicyHash ?? previous.policyHash,
      scorerVersion: previous.lastEvaluatedScorerVersion ?? previous.scorerVersion,
    }
    const completedAt =
      // Replay do mesmo resultado terminal: preserva o `completed_at` original.
      previousOutcome.status === 'completed' &&
      previousOutcome.completedAt !== null &&
      !stillPartial &&
      decision.verdict === previousOutcome.verdict &&
      evidenceSetHash === previousOutcome.evidenceSetHash &&
      previousOutcome.policyHash === deps.policyHash &&
      previousOutcome.scorerVersion === SCORER_VERSION
        ? previousOutcome.completedAt
        : deps.clock.now()

    await updateValidationOutcome(tx, {
      validationId: input.validationId,
      stillPartial,
      verdict: decision.verdict,
      score,
      confidence: decision.confidence,
      evidenceSetHash,
      policyHash: deps.policyHash,
      scorerVersion: SCORER_VERSION,
      explanation: {
        summary: decision.explanation,
        code: explanationDetail.code,
        supporting_evidence: explanationDetail.supportingEvidenceIds,
        contradicting_evidence: explanationDetail.contradictingEvidenceIds,
      },
      completedAt,
    })

    // C1: mesma transação da nova conclusão. Se a revogação falhar, o novo
    // resultado NÃO é persistido — não existe janela com credencial ACTIVE
    // apontando para uma conclusão que já mudou.
    if (
      outcomeSupersedesCredentials(previousOutcome, {
        stillPartial,
        verdict: decision.verdict,
        evidenceSetHash,
        policyHash: deps.policyHash,
        scorerVersion: SCORER_VERSION,
      })
    ) {
      await supersedeIssuedCredentials(tx, input.tenantId, input.validationId)
    }

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
