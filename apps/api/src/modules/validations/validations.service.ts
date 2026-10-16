import { eq, withTenant } from '@comprova/db'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import { encryptSecret } from '../../shared/secretbox.js'

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
    return { validation, signals }
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
