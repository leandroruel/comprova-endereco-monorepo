import { eq, inArray } from '@comprova/db'
import type { DbTx } from '@comprova/db'
import * as t from '@comprova/db'
import type { ClaimType, Signal, SubjectType, Verdict } from '@comprova/core'
import { randomUUID } from 'node:crypto'
import type { PriorSignalRow } from './deep-enrich.signals.js'

export interface ClaimKey {
  readonly tenantId: string
  readonly validationId: string
  readonly subjectId: string
  readonly addressId: string | null
  readonly claimType: ClaimType
  readonly subjectType: SubjectType
}

/**
 * Reusa o claim criado pelo fast path; cria um se ausente (validação legada ou
 * criada fora do fast path). A unicidade `(validation_id, type)` evita duplicata.
 */
export const resolveClaimId = async (tx: DbTx, key: ClaimKey): Promise<string | null> => {
  const existing = await tx
    .select({ claimId: t.claim.claimId })
    .from(t.claim)
    .where(eq(t.claim.validationId, key.validationId))
    .limit(1)
  const existingId = existing[0]?.claimId ?? null
  if (existingId !== null) return existingId

  await tx
    .insert(t.claim)
    .values({
      claimId: randomUUID(),
      tenantId: key.tenantId,
      validationId: key.validationId,
      subjectId: key.subjectId,
      addressId: key.addressId,
      type: key.claimType,
      subjectType: key.subjectType,
      targetType: 'address',
    })
    .onConflictDoNothing()

  const recreated = await tx
    .select({ claimId: t.claim.claimId })
    .from(t.claim)
    .where(eq(t.claim.validationId, key.validationId))
    .limit(1)
  return recreated[0]?.claimId ?? null
}

export interface FreshSignalsWrite {
  readonly validationId: string
  readonly addressId: string | null
  readonly signals: readonly Signal[]
  /**
   * Referência de tempo do cache por endereço (`now + ttl`). É o instante de
   * avaliação, não o de conclusão: o `observed_at` de cada sinal vem do próprio
   * sinal.
   */
  readonly now: Date
}

/** Persiste sinais novos e o cache por endereço; devolve os `signal_id` gerados. */
export const persistFreshSignals = async (tx: DbTx, write: FreshSignalsWrite): Promise<readonly string[]> => {
  if (write.signals.length === 0) return []
  const addressId = write.addressId
  const signalIds = write.signals.map(() => randomUUID())

  await tx.insert(t.signal).values(
    write.signals.map((s, index) => ({
      signalId: signalIds[index] ?? randomUUID(),
      validationId: write.validationId,
      checkerId: s.checkerId,
      checkerVersion: s.checkerVersion,
      stance: s.stance,
      strength: s.strength,
      confidence: s.confidence,
      source: s.source,
      observedAt: new Date(s.observedAt),
      ttlSeconds: s.ttlSeconds,
      detail: s.detail,
      evidenceId: s.evidenceId ?? null,
    })),
  )

  if (addressId !== null) {
    await tx
      .insert(t.addressSignalCache)
      .values(
        write.signals.map((s) => ({
          addressId,
          checkerId: s.checkerId,
          checkerVersion: s.checkerVersion,
          stance: s.stance,
          strength: s.strength,
          confidence: s.confidence,
          source: s.source,
          observedAt: new Date(s.observedAt),
          expiresAt: new Date(write.now.getTime() + s.ttlSeconds * 1000),
          detail: s.detail,
        })),
      )
      .onConflictDoNothing()
  }

  return signalIds
}

export interface ClaimEvidenceWrite {
  readonly tenantId: string
  readonly claimId: string | null
  readonly priorSignals: readonly PriorSignalRow[]
  readonly freshSignals: readonly Signal[]
  readonly freshSignalIds: readonly string[]
}

/**
 * FASE 7: toda observação de uma validation com claim tem um `claim_evidence`.
 * Aqui garantimos idempotentemente o vínculo dos T0 pré-existentes (validações
 * legadas) e dos novos T1/T2, sem duplicar linhas já persistidas.
 */
export const linkClaimEvidence = async (tx: DbTx, write: ClaimEvidenceWrite): Promise<void> => {
  const claimId = write.claimId
  if (claimId === null) return

  const existingEvidenceSignalIds = new Set(
    (
      await tx
        .select({ signalId: t.claimEvidence.signalId })
        .from(t.claimEvidence)
        .where(eq(t.claimEvidence.claimId, claimId))
    )
      .map((row) => row.signalId)
      .filter((id): id is string => id !== null),
  )

  const priorToBackfill = write.priorSignals.filter((row) => !existingEvidenceSignalIds.has(row.signalId))

  // BAIXO-8: `signal.evidence_id` pode carregar semântica legada (apontar para um
  // `claim_evidence_id`, não para `evidence`). Só propagamos para
  // `claim_evidence.evidence_id` os ids que existem de fato em `evidence`.
  const candidateEvidenceIds = [
    ...priorToBackfill.map((row) => row.evidenceId),
    ...write.freshSignals.map((s) => s.evidenceId ?? null),
  ].filter((id): id is string => id !== null && id.length > 0)

  // V-3: além de existir, o material precisa do digest para o binding durável em
  // `claim_evidence.evidence_sha256`.
  const materialRows =
    candidateEvidenceIds.length > 0
      ? await tx
          .select({ evidenceId: t.evidence.evidenceId, sha256: t.evidence.sha256 })
          .from(t.evidence)
          .where(inArray(t.evidence.evidenceId, [...new Set(candidateEvidenceIds)]))
      : []
  const materialShaByEvidenceId: ReadonlyMap<string, Buffer> = new Map(
    materialRows.map((row) => [row.evidenceId, Buffer.from(row.sha256)]),
  )
  const materialEvidenceIdOf = (candidate: string | null): string | null =>
    candidate !== null && materialShaByEvidenceId.has(candidate) ? candidate : null
  const materialShaOf = (materialId: string | null): Buffer | null =>
    materialId === null ? null : (materialShaByEvidenceId.get(materialId) ?? null)

  const observations = [
    ...priorToBackfill.map((row) => {
      const materialId = materialEvidenceIdOf(row.evidenceId)
      return {
        claimEvidenceId: randomUUID(),
        tenantId: write.tenantId,
        claimId,
        signalId: row.signalId,
        // Vínculo opcional com artefato material; nulo para T0 sem arquivo (ou
        // para ids legados que não existem em `evidence`).
        evidenceId: materialId,
        evidenceSha256: materialShaOf(materialId),
        checker: row.checkerId,
        checkerVersion: row.checkerVersion,
        stance: row.stance === 'neutral' ? ('unknown' as const) : row.stance,
        strength: row.strength,
        confidence: row.confidence,
        source: row.source,
        observedAt: row.observedAt,
        ttlSeconds: row.ttlSeconds,
        expiresAt: new Date(row.observedAt.getTime() + row.ttlSeconds * 1000),
        detail: row.detail,
      }
    }),
    ...write.freshSignals.map((s, index) => {
      const materialId = materialEvidenceIdOf(s.evidenceId ?? null)
      return {
        claimEvidenceId: randomUUID(),
        tenantId: write.tenantId,
        claimId,
        signalId: write.freshSignalIds[index] ?? null,
        evidenceId: materialId,
        evidenceSha256: materialShaOf(materialId),
        checker: s.checkerId,
        checkerVersion: s.checkerVersion,
        stance: s.stance === 'neutral' ? ('unknown' as const) : s.stance,
        strength: s.strength,
        confidence: s.confidence,
        source: s.source,
        observedAt: new Date(s.observedAt),
        ttlSeconds: s.ttlSeconds,
        expiresAt: new Date(Date.parse(s.observedAt) + s.ttlSeconds * 1000),
        detail: s.detail,
      }
    }),
  ]

  if (observations.length > 0) {
    await tx.insert(t.claimEvidence).values(observations)
  }
}

/** §9/§10: evidências duráveis do conjunto usado pelo resultado final. */
export const readEvidenceSet = async (tx: DbTx, claimId: string | null) =>
  claimId === null
    ? []
    : await tx
        .select({
          id: t.claimEvidence.claimEvidenceId,
          checker: t.claimEvidence.checker,
          checkerVersion: t.claimEvidence.checkerVersion,
          stance: t.claimEvidence.stance,
          strength: t.claimEvidence.strength,
          confidence: t.claimEvidence.confidence,
          source: t.claimEvidence.source,
          observedAt: t.claimEvidence.observedAt,
          evidenceSha256: t.claimEvidence.evidenceSha256,
          detail: t.claimEvidence.detail,
        })
        .from(t.claimEvidence)
        .where(eq(t.claimEvidence.claimId, claimId))

export interface ValidationOutcomeWrite {
  readonly validationId: string
  readonly stillPartial: boolean
  readonly verdict: Verdict
  readonly score: number
  readonly confidence: number
  readonly evidenceSetHash: string
  readonly explanation: {
    readonly summary: string
    readonly code: string
    readonly supporting_evidence: readonly string[]
    readonly contradicting_evidence: readonly string[]
  }
  /**
   * Instante REAL da conclusão do resultado terminal (não o instante de
   * avaliação/score). Ignorado quando `stillPartial`: aí `completed_at` fica
   * NULL, porque a validação ainda pode ser concluída por outra execução.
   */
  readonly completedAt: Date
}

export const updateValidationOutcome = async (tx: DbTx, write: ValidationOutcomeWrite): Promise<void> => {
  await tx
    .update(t.validation)
    .set({
      status: write.stillPartial ? 'partial' : 'completed',
      verdict: write.verdict,
      score: Math.tanh(write.score),
      confidence: write.confidence,
      evidenceSetHash: write.evidenceSetHash,
      explanation: {
        summary: write.explanation.summary,
        code: write.explanation.code,
        supporting_evidence: [...write.explanation.supporting_evidence],
        contradicting_evidence: [...write.explanation.contradicting_evidence],
      },
      completedAt: write.stillPartial ? null : write.completedAt,
    })
    .where(eq(t.validation.validationId, write.validationId))
}

export interface OutcomeEventsWrite {
  readonly tenantId: string
  readonly validationId: string
  readonly claimId: string | null
  readonly claimType: ClaimType
  readonly stillPartial: boolean
  readonly verdict: Verdict
}

export const emitOutcomeEvents = async (tx: DbTx, write: OutcomeEventsWrite): Promise<void> => {
  await tx.insert(t.outbox).values({
    aggregate: 'validation',
    aggregateId: write.validationId,
    eventType: write.stillPartial ? 'validation.updated' : 'validation.completed',
    payload: {
      tenant_id: write.tenantId,
      validation_id: write.validationId,
      claim_id: write.claimId,
      claim_type: write.claimType,
      verdict: write.verdict,
    },
  })

  await tx.insert(t.usageEvent).values({
    tenantId: write.tenantId,
    kind: 'deep',
    units: 1,
    validationId: write.validationId,
  })
}
