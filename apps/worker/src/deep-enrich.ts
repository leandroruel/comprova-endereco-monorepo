import { eq } from '@comprova/db'
import {
  decide,
  weightedScore,
  type CheckContext,
  type Checker,
  type Clock,
  type EstabelecimentoRecord,
  type Policy,
  type Signal,
  type Verdict,
} from '@comprova/core'
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
  const score = weightedScore(allSignals, deps.policy, now)
  const decision = decide({ signals: allSignals, score, policy: deps.policy, now })
  const stillPartial = decision.verdict === 'INSUFFICIENT_EVIDENCE' || decision.confidence < 0.55

  await withTenant(deps.db, input.tenantId, async (tx) => {
    const existingCheckerIds = new Set(signals.map((s) => `${s.checkerId}@${s.checkerVersion}`))
    const freshSignals = [...newSignals, ...t2Signals].filter(
      (s) => !existingCheckerIds.has(`${s.checkerId}@${s.checkerVersion}`),
    )

    if (freshSignals.length > 0) {
      await tx.insert(t.signal).values(
        freshSignals.map((s) => ({
          signalId: randomUUID(),
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

    await tx
      .update(t.validation)
      .set({
        status: stillPartial ? 'partial' : 'completed',
        verdict: decision.verdict,
        score: Math.tanh(score),
        confidence: decision.confidence,
        explanation: { summary: decision.explanation },
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
        verdict: decision.verdict,
      },
    })

    await tx.insert(t.usageEvent).values({
      tenantId: input.tenantId,
      kind: 'deep',
      units: 1,
      validationId: input.validationId,
    })
  })

  return {
    status: stillPartial ? 'partial' : 'completed',
    verdict: decision.verdict,
    confidence: decision.confidence,
    score: Math.tanh(score),
    explanation: decision.explanation,
    newSignals: newSignals.length + t2Signals.length,
    t2Signals: t2Signals.length,
  }
}
