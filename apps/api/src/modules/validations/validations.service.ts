import { FISCAL_SOURCE_KIND, UPLOADED_DOCUMENT_CHECKER, UPLOADED_DOCUMENT_SOURCE } from '@comprova/core'
import { and, desc, eq, sql, withTenant } from '@comprova/db'
import type { Db, DbTx } from '@comprova/db'
import * as t from '@comprova/db'
import { encryptSecret } from '../../shared/secretbox.js'

const evidenceSummaryForClaim = async (
  tx: DbTx,
  claimId: string,
): Promise<{ supporting: number; contradicting: number; unknown: number }> => {
  const rows = await tx
    .select({ stance: t.claimEvidence.stance, count: sql<number>`count(*)::int` })
    .from(t.claimEvidence)
    .where(eq(t.claimEvidence.claimId, claimId))
    .groupBy(t.claimEvidence.stance)
  const byStance = new Map(rows.map((row) => [row.stance, row.count]))
  return {
    supporting: byStance.get('supports') ?? 0,
    contradicting: byStance.get('contradicts') ?? 0,
    unknown: byStance.get('unknown') ?? 0,
  }
}

// BAIXO-7: mesma representação de endereço usada pelo POST (fast path/replay),
// para que POST e GET devolvam o MESMO estado persistido. O `building_key` é
// serializado como `b64:<base64url>` — idêntico ao fast path.
const loadAddressSummary = async (
  tx: DbTx,
  addressId: string,
): Promise<{
  buildingKey: string
  country: string
  uf: string | null
  geoPrecision: 'ROOFTOP' | 'RANGE_INTERPOLATED' | 'GEOMETRIC_CENTER' | 'APPROXIMATE' | 'NONE'
} | null> => {
  const rows = await tx
    .select({
      buildingKey: t.canonicalAddress.buildingKey,
      countryCode: t.canonicalAddress.countryCode,
      uf: t.canonicalAddress.uf,
      geoPrecision: t.canonicalAddress.geoPrecision,
    })
    .from(t.canonicalAddress)
    .where(eq(t.canonicalAddress.addressId, addressId))
    .limit(1)
  const row = rows[0]
  if (row === undefined) return null
  return {
    buildingKey: `b64:${Buffer.from(row.buildingKey).toString('base64url')}`,
    country: row.countryCode,
    uf: row.uf,
    geoPrecision: row.geoPrecision,
  }
}

export const getValidationDetails = async (db: Db, tenantId: string, validationId: string) =>
  withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        validationId: t.validation.validationId,
        status: t.validation.status,
        verdict: t.validation.verdict,
        score: t.validation.score,
        confidence: t.validation.confidence,
        policyVersion: t.validation.policyVersion,
        explanation: t.validation.explanation,
        addressId: t.validation.addressId,
        createdAt: t.validation.createdAt,
        expiresAt: t.validation.expiresAt,
      })
      .from(t.validation)
      .where(eq(t.validation.validationId, validationId))
      .limit(1)
    const validation = rows[0]
    if (validation === undefined) return null

    const signals = await tx
      .select({
        checkerId: t.signal.checkerId,
        checkerVersion: t.signal.checkerVersion,
        stance: t.signal.stance,
        strength: t.signal.strength,
        confidence: t.signal.confidence,
        source: t.signal.source,
        observedAt: t.signal.observedAt,
        ttlSeconds: t.signal.ttlSeconds,
        detail: t.signal.detail,
        evidenceId: t.signal.evidenceId,
      })
      .from(t.signal)
      .where(eq(t.signal.validationId, validationId))
      .orderBy(t.signal.createdAt)

    // O claim e o resumo de observações tornam explícita a nova semântica
    // (validation → claim → claim_evidence) também na leitura (GET).
    const claimRows = await tx
      .select({
        claimId: t.claim.claimId,
        type: t.claim.type,
        subjectType: t.claim.subjectType,
        subjectId: t.claim.subjectId,
        targetType: t.claim.targetType,
        addressId: t.claim.addressId,
      })
      .from(t.claim)
      .where(eq(t.claim.validationId, validationId))
      .limit(1)
    const claim = claimRows[0] ?? null
    const evidenceSummary = claim === null ? null : await evidenceSummaryForClaim(tx, claim.claimId)

    // F1.3: a leitura corrente é a verificação materializada mais recente.
    // Versões anteriores permanecem no banco para auditoria, mas não são
    // sobrescritas (claim_evidence é imutável).
    const verificationRows =
      claim === null
        ? []
        : await tx
            .select({ detail: t.claimEvidence.detail })
            .from(t.claimEvidence)
            .where(
              and(
                eq(t.claimEvidence.claimId, claim.claimId),
                eq(t.claimEvidence.source, UPLOADED_DOCUMENT_SOURCE),
                eq(t.claimEvidence.checker, UPLOADED_DOCUMENT_CHECKER),
              ),
            )
            .orderBy(desc(t.claimEvidence.observedAt), desc(t.claimEvidence.createdAt))
            .limit(1)
    const evidenceVerification = verificationRows[0]?.detail.verification ?? null

    // F2: a leitura corrente da consulta fiscal é a observação mais recente
    // (mesma no-op de versão do F1.3; o histórico permanece para auditoria).
    const fiscalRows =
      claim === null
        ? []
        : await tx
            .select({ detail: t.claimEvidence.detail })
            .from(t.claimEvidence)
            .where(
              and(
                eq(t.claimEvidence.claimId, claim.claimId),
                eq(t.claimEvidence.source, FISCAL_SOURCE_KIND['nf3e']),
              ),
            )
            .orderBy(desc(t.claimEvidence.observedAt), desc(t.claimEvidence.createdAt))
            .limit(1)
    const fiscalVerification = fiscalRows[0]?.detail.verification ?? null

    const address = validation.addressId === null ? null : await loadAddressSummary(tx, validation.addressId)

    return { validation, signals, claim, evidenceSummary, evidenceVerification, fiscalVerification, address }
  })

export const setWorkflowId = async (
  db: Db,
  tenantId: string,
  validationId: string,
  workflowId: string,
): Promise<void> =>
  withTenant(db, tenantId, async (tx) => {
    await tx.update(t.validation).set({ workflowId }).where(eq(t.validation.validationId, validationId))
  })

export const contestValidation = async (
  db: Db,
  tenantId: string,
  apiKeyId: string,
  validationId: string,
  reason: string,
  encryptionKey: string,
): Promise<boolean> =>
  withTenant(db, tenantId, async (tx) => {
    const exists = await tx
      .select({ validationId: t.validation.validationId })
      .from(t.validation)
      .where(eq(t.validation.validationId, validationId))
      .limit(1)
    if (exists.length === 0) return false

    await tx.insert(t.auditLog).values({
      tenantId,
      actor: `api-key:${apiKeyId}`,
      action: 'validation.contested',
      targetType: 'validation',
      targetId: validationId,
      details: {
        reason_enc: encryptSecret(encryptionKey, reason).toString('base64'),
        reason_length: reason.length,
      },
    })
    await tx.insert(t.outbox).values({
      aggregate: 'validation',
      aggregateId: validationId,
      eventType: 'validation.contested',
      payload: {
        tenant_id: tenantId,
        validation_id: validationId,
      },
    })
    return true
  })
