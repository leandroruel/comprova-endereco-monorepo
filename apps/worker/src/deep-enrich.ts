import { eq, inArray } from '@comprova/db'
import {
  buildAssessmentExplanation,
  decide,
  evaluateClaim,
  observationFromSignal,
  weightedScore,
  evidenceSetHashOfObservations,
  type CheckContext,
  type Checker,
  type ClaimType,
  type Clock,
  type EstabelecimentoRecord,
  type Policy,
  type Signal,
  type SubjectType,
  type Verdict,
} from '@comprova/core'
import type { SignalCacheReader } from '@comprova/core'
import type { Db } from '@comprova/db'
import { withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { randomUUID } from 'node:crypto'

export interface DeepEnrichInput {
  readonly tenantId: string
  readonly validationId: string
  readonly maxTier?: number
}

export interface DeepEnrichDeps {
  readonly db: Db
  readonly t1Checkers: readonly Checker[]
  readonly t2Checkers?: readonly Checker[]
  readonly policy: Policy
  readonly clock: Clock
  readonly signalCache?: SignalCacheReader
}

export interface DeepEnrichResult {
  readonly status: 'completed' | 'partial'
  readonly verdict: Verdict
  readonly confidence: number
  readonly score: number
  readonly explanation: string
  readonly newSignals: number
  readonly t2Signals: number
}

const hexToBuffer = (hex: unknown): Buffer | null =>
  typeof hex === 'string' ? Buffer.from(hex, 'hex') : null

export const registryRecordFromDeepContext = (
  deepContext: Record<string, unknown> | null,
): { readonly record: EstabelecimentoRecord; readonly docDigitsValid: boolean } | null => {
  if (deepContext === null) return null
  const raw = deepContext['record']
  const docDigitsValid = deepContext['docDigitsValid'] === true
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  return {
    docDigitsValid,
    record: {
      cnpjBasico: String(r['cnpjBasico'] ?? ''),
      cnpjOrdem: String(r['cnpjOrdem'] ?? ''),
      cnpjDv: String(r['cnpjDv'] ?? ''),
      matrizFilial: Number(r['matrizFilial'] ?? 1),
      nomeFantasia: (r['nomeFantasia'] as string | null) ?? null,
      situacaoCadastral: Number(r['situacaoCadastral'] ?? 0),
      dataSituacao: (r['dataSituacao'] as string | null) ?? null,
      motivoSituacao: (r['motivoSituacao'] as number | null) ?? null,
      dataAbertura: (r['dataAbertura'] as string | null) ?? null,
      cnaePrincipal: (r['cnaePrincipal'] as string | null) ?? null,
      cnaesSecundarios: (r['cnaesSecundarios'] as readonly string[] | null) ?? null,
      tipoLogradouro: (r['tipoLogradouro'] as string | null) ?? null,
      logradouro: (r['logradouro'] as string | null) ?? null,
      numero: (r['numero'] as string | null) ?? null,
      complemento: (r['complemento'] as string | null) ?? null,
      bairro: (r['bairro'] as string | null) ?? null,
      cep: (r['cep'] as string | null) ?? null,
      uf: (r['uf'] as string | null) ?? null,
      municipioReceita: (r['municipioReceita'] as number | null) ?? null,
      municipioIbge: (r['municipioIbge'] as number | null) ?? null,
      paisCodigo: (r['paisCodigo'] as number | null) ?? null,
      cidadeExterior: (r['cidadeExterior'] as string | null) ?? null,
      buildingKey: hexToBuffer(r['buildingKey']),
      unitKey: hexToBuffer(r['unitKey']),
      telefone: (r['telefone'] as string | null) ?? null,
      emailDomain: (r['emailDomain'] as string | null) ?? null,
    },
  }
}

export const deepEnrich = async (deps: DeepEnrichDeps, input: DeepEnrichInput): Promise<DeepEnrichResult> => {
  const now = deps.clock.now()

  const validationRows = await withTenant(deps.db, input.tenantId, (tx) =>
    tx.select().from(t.validation).where(eq(t.validation.validationId, input.validationId)).limit(1),
  )
  const validation = validationRows[0]
  if (validation === undefined) {
    throw new Error(`validation ${input.validationId} not found for tenant`)
  }
  const subjectRows = await withTenant(deps.db, input.tenantId, (tx) =>
    tx.select().from(t.subject).where(eq(t.subject.subjectId, validation.subjectId)).limit(1),
  )
  const subject = subjectRows[0]
  if (subject === undefined) {
    throw new Error(`subject ${validation.subjectId} not found`)
  }

  const priorSignals = await withTenant(deps.db, input.tenantId, (tx) =>
    tx.select().from(t.signal).where(eq(t.signal.validationId, input.validationId)),
  )
  const signals: readonly Signal[] = priorSignals.map((row) => ({
    checkerId: row.checkerId,
    checkerVersion: row.checkerVersion,
    stance: row.stance,
    strength: row.strength,
    confidence: row.confidence,
    source: row.source,
    observedAt: row.observedAt.toISOString(),
    ttlSeconds: row.ttlSeconds,
    detail: row.detail,
  }))

  const deepRegistry = registryRecordFromDeepContext(validation.deepContext ?? null)

  const addressRows =
    validation.addressId === null
      ? []
      : await deps.db
          .select({
            buildingKey: t.canonicalAddress.buildingKey,
            countryCode: t.canonicalAddress.countryCode,
            uf: t.canonicalAddress.uf,
            municipioIbge: t.canonicalAddress.municipioIbge,
            cep: t.canonicalAddress.cep,
            logradouroNorm: t.canonicalAddress.logradouroNorm,
            numero: t.canonicalAddress.numero,
            bairroNorm: t.canonicalAddress.bairroNorm,
          })
          .from(t.canonicalAddress)
          .where(eq(t.canonicalAddress.addressId, validation.addressId))
          .limit(1)
  const addressRow = addressRows[0]

  const ctx: CheckContext = {
    subject: {
      docType: subject.docType,
      docDigitsValid: deepRegistry?.docDigitsValid ?? true,
      pseudonymized: true,
    },
    ...(deepRegistry !== null ? { registryRecord: deepRegistry.record } : {}),
    address:
      addressRow === undefined || addressRow.buildingKey === null
        ? null
        : {
            buildingKey: Buffer.from(addressRow.buildingKey),
            country: addressRow.countryCode,
            uf: addressRow.uf ?? undefined,
            cep: addressRow.cep ?? undefined,
            municipioIbge: addressRow.municipioIbge ?? undefined,
            logradouroNorm: addressRow.logradouroNorm ?? undefined,
            numero: addressRow.numero ?? undefined,
            bairroNorm: addressRow.bairroNorm ?? undefined,
          },
    priorSignals: signals,
    clock: deps.clock,
    metrics: {
      increment: () => undefined,
      observe: () => undefined,
    },
  }

  const runCheckerList = async (
    checkers: readonly Checker[],
    prior: readonly Signal[],
  ): Promise<readonly Signal[]> =>
    checkers.reduce<Promise<readonly Signal[]>>(async (acc, checker) => {
      const list = await acc
      if (!checker.appliesTo.includes(subject.docType)) return list

      if (validation.addressId !== null && deps.signalCache !== undefined) {
        const cached = await deps.signalCache.getCached(validation.addressId, checker.id)
        if (cached !== null) {
          return [
            ...list,
            {
              checkerId: cached.checkerId,
              checkerVersion: cached.checkerVersion,
              stance: cached.stance,
              strength: cached.strength,
              confidence: cached.confidence,
              source: cached.source,
              observedAt: cached.observedAt,
              ttlSeconds: cached.ttlSeconds,
              detail: cached.detail,
              ...(cached.evidenceId !== undefined ? { evidenceId: cached.evidenceId } : {}),
            },
          ]
        }
      }

      const produced = await checker.run({ ...ctx, priorSignals: [...prior, ...list] })
      return [...list, ...produced]
    }, Promise.resolve([]))

  const newSignals = await runCheckerList(deps.t1Checkers, signals)

  const signalsAfterT1: readonly Signal[] = [...signals, ...newSignals]
  const scoreAfterT1 = weightedScore(signalsAfterT1, deps.policy, now)
  const decisionAfterT1 = decide({
    signals: signalsAfterT1,
    score: scoreAfterT1,
    policy: deps.policy,
    now,
  })
  const ambiguousAfterT1 =
    decisionAfterT1.verdict === 'INSUFFICIENT_EVIDENCE' || decisionAfterT1.confidence < 0.55
  const maxTier = input.maxTier ?? 2
  const t2Signals =
    ambiguousAfterT1 && maxTier >= 2 && deps.t2Checkers !== undefined
      ? await runCheckerList(deps.t2Checkers, signalsAfterT1)
      : []

  const allSignals: readonly Signal[] = [...signalsAfterT1, ...t2Signals]
  const claimType: ClaimType = subject.docType === 'CNPJ' ? 'business_registered_address' : 'address_exists'
  const subjectType: SubjectType = subject.docType === 'CNPJ' ? 'organization' : 'person'

  const outcome = await withTenant(deps.db, input.tenantId, async (tx) => {
    const existingCheckerIds = new Set(signals.map((s) => `${s.checkerId}@${s.checkerVersion}`))
    const freshSignals = [...newSignals, ...t2Signals].filter(
      (s) => !existingCheckerIds.has(`${s.checkerId}@${s.checkerVersion}`),
    )

    // Reusa o claim criado pelo fast path; cria um se ausente (validação legada
    // ou criada fora do fast path). A unicidade (validation_id, type) evita duplicata.
    const existingClaim = await tx
      .select({ claimId: t.claim.claimId })
      .from(t.claim)
      .where(eq(t.claim.validationId, input.validationId))
      .limit(1)
    let claimId: string | null = existingClaim[0]?.claimId ?? null
    if (claimId === null) {
      await tx
        .insert(t.claim)
        .values({
          claimId: randomUUID(),
          tenantId: input.tenantId,
          validationId: input.validationId,
          subjectId: validation.subjectId,
          addressId: validation.addressId,
          type: claimType,
          subjectType,
          targetType: 'address',
        })
        .onConflictDoNothing()
      const recreated = await tx
        .select({ claimId: t.claim.claimId })
        .from(t.claim)
        .where(eq(t.claim.validationId, input.validationId))
        .limit(1)
      claimId = recreated[0]?.claimId ?? null
    }

    const { score, decision } = evaluateClaim({
      claim: { id: claimId ?? '', type: claimType },
      evidence: allSignals.map(observationFromSignal),
      policy: deps.policy,
      now,
    })
    const stillPartial = decision.verdict === 'INSUFFICIENT_EVIDENCE' || decision.confidence < 0.55

    let freshSignalIds: string[] = []
    if (freshSignals.length > 0) {
      freshSignalIds = freshSignals.map(() => randomUUID())
      await tx.insert(t.signal).values(
        freshSignals.map((s, index) => ({
          signalId: freshSignalIds[index] ?? randomUUID(),
          validationId: input.validationId,
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

      const addressId = validation.addressId
      if (addressId !== null) {
        await tx
          .insert(t.addressSignalCache)
          .values(
            freshSignals.map((s) => ({
              addressId,
              checkerId: s.checkerId,
              checkerVersion: s.checkerVersion,
              stance: s.stance,
              strength: s.strength,
              confidence: s.confidence,
              source: s.source,
              observedAt: new Date(s.observedAt),
              expiresAt: new Date(now.getTime() + s.ttlSeconds * 1000),
              detail: s.detail,
            })),
          )
          .onConflictDoNothing()
      }
    }

    // FASE 7: toda observação (signal) de uma validation com claim deve ter um
    // `claim_evidence` correspondente. O fast path já cobre os T0; aqui garantimos
    // idempotentemente o vínculo dos T0 pré-existentes (validações legadas, criadas
    // antes do claim existir) e dos novos T1/T2, sem duplicar linhas já persistidas.
    if (claimId !== null) {
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

      const priorToBackfill = priorSignals.filter((row) => !existingEvidenceSignalIds.has(row.signalId))

      // BAIXO-8: `signal.evidence_id` pode carregar semântica legada (apontar para
      // um `claim_evidence_id`, não para `evidence`). Só propagamos para
      // `claim_evidence.evidence_id` os ids que existem de fato em `evidence`.
      const candidateEvidenceIds = [
        ...priorToBackfill.map((row) => row.evidenceId),
        ...freshSignals.map((s) => s.evidenceId ?? null),
      ].filter((id): id is string => id !== null && id.length > 0)
      // V-3: além de existir, o material precisa do digest para o binding
      // durável em `claim_evidence.evidence_sha256`.
      const materialShaByEvidenceId = new Map<string, Buffer>()
      if (candidateEvidenceIds.length > 0) {
        const materialRows = await tx
          .select({ evidenceId: t.evidence.evidenceId, sha256: t.evidence.sha256 })
          .from(t.evidence)
          .where(inArray(t.evidence.evidenceId, [...new Set(candidateEvidenceIds)]))
        for (const row of materialRows) {
          materialShaByEvidenceId.set(row.evidenceId, Buffer.from(row.sha256))
        }
      }
      const materialEvidenceIdOf = (candidate: string | null): string | null =>
        candidate !== null && materialShaByEvidenceId.has(candidate) ? candidate : null
      const materialShaOf = (materialId: string | null): Buffer | null =>
        materialId === null ? null : (materialShaByEvidenceId.get(materialId) ?? null)

      const observations = [
        ...priorToBackfill.map((row) => {
          const materialId = materialEvidenceIdOf(row.evidenceId)
          return {
            claimEvidenceId: randomUUID(),
            tenantId: input.tenantId,
            claimId,
            signalId: row.signalId,
            // Vínculo opcional com artefato material; nulo para T0 sem arquivo
            // (ou para ids legados que não existem em `evidence`).
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
        ...freshSignals.map((s, index) => {
          const materialId = materialEvidenceIdOf(s.evidenceId ?? null)
          return {
            claimEvidenceId: randomUUID(),
            tenantId: input.tenantId,
            claimId,
            signalId: freshSignalIds[index] ?? null,
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

    // §9/§10: evidências duráveis do conjunto usado pelo resultado final.
    const evidenceRows =
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
    const explanationDetail = buildAssessmentExplanation(
      decision,
      evidenceRows.map((row) => ({ id: row.id, stance: row.stance })),
    )
    const evidenceSetHash = evidenceSetHashOfObservations(evidenceRows)

    await tx
      .update(t.validation)
      .set({
        status: stillPartial ? 'partial' : 'completed',
        verdict: decision.verdict,
        score: Math.tanh(score),
        confidence: decision.confidence,
        evidenceSetHash,
        explanation: {
          summary: decision.explanation,
          code: explanationDetail.code,
          supporting_evidence: [...explanationDetail.supportingEvidenceIds],
          contradicting_evidence: [...explanationDetail.contradictingEvidenceIds],
        },
        completedAt: stillPartial ? null : now,
      })
      .where(eq(t.validation.validationId, input.validationId))

    await tx.insert(t.outbox).values({
      aggregate: 'validation',
      aggregateId: input.validationId,
      eventType: stillPartial ? 'validation.updated' : 'validation.completed',
      payload: {
        tenant_id: input.tenantId,
        validation_id: input.validationId,
        claim_id: claimId,
        claim_type: claimType,
        verdict: decision.verdict,
      },
    })

    await tx.insert(t.usageEvent).values({
      tenantId: input.tenantId,
      kind: 'deep',
      units: 1,
      validationId: input.validationId,
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
