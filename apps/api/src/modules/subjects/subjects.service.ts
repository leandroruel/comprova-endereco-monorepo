import { and, eq, inArray, withTenant } from '@comprova/db'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'

export interface SubjectValidation {
  readonly validationId: string
  readonly status: string
  readonly verdict: string | null
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly legalBasis: string
  readonly consentRef: string | null
}

export const listSubjectValidations = async (
  db: Db,
  tenantId: string,
  subjectId: string,
): Promise<{ readonly found: boolean; readonly validations: readonly SubjectValidation[] }> => {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        validationId: t.validation.validationId,
        status: t.validation.status,
        verdict: t.validation.verdict,
        createdAt: t.validation.createdAt,
        expiresAt: t.validation.expiresAt,
        legalBasis: t.validation.legalBasis,
        consentRef: t.validation.consentRef,
      })
      .from(t.validation)
      .innerJoin(t.subject, eq(t.validation.subjectId, t.subject.subjectId))
      .where(and(eq(t.subject.subjectId, subjectId), eq(t.subject.tenantId, tenantId))),
  )

  if (rows.length > 0) return { found: true, validations: rows }

  const subjects = await withTenant(db, tenantId, (tx) =>
    tx
      .select({ subjectId: t.subject.subjectId })
      .from(t.subject)
      .where(eq(t.subject.subjectId, subjectId))
      .limit(1),
  )
  return { found: subjects.length > 0, validations: rows }
}

export const eraseSubject = async (
  db: Db,
  tenantId: string,
  apiKeyId: string,
  subjectId: string,
): Promise<number | null> =>
  withTenant(db, tenantId, async (tx) => {
    const subject = await tx
      .select({ subjectId: t.subject.subjectId })
      .from(t.subject)
      .where(eq(t.subject.subjectId, subjectId))
      .limit(1)
    if (subject.length === 0) return null

    const validations = await tx
      .select({ validationId: t.validation.validationId })
      .from(t.validation)
      .where(eq(t.validation.subjectId, subjectId))
    const validationIds = validations.map((validation) => validation.validationId)

    if (validationIds.length > 0) {
      const claims = await tx
        .select({ claimId: t.claim.claimId })
        .from(t.claim)
        .where(inArray(t.claim.validationId, validationIds))
      if (claims.length > 0) {
        await tx.delete(t.claimEvidence).where(
          inArray(
            t.claimEvidence.claimId,
            claims.map((claim) => claim.claimId),
          ),
        )
      }
      await tx.delete(t.claim).where(inArray(t.claim.validationId, validationIds))
      await tx.delete(t.signal).where(inArray(t.signal.validationId, validationIds))
    }
    await tx
      .delete(t.validationIdempotency)
      .where(
        validationIds.length > 0
          ? inArray(t.validationIdempotency.validationId, validationIds)
          : eq(t.validationIdempotency.validationId, subjectId),
      )
    await tx.delete(t.validation).where(eq(t.validation.subjectId, subjectId))
    await tx.delete(t.subject).where(eq(t.subject.subjectId, subjectId))

    await tx.insert(t.auditLog).values({
      tenantId,
      actor: `api-key:${apiKeyId}`,
      action: 'subject.erasure',
      targetType: 'subject',
      targetId: subjectId,
      details: { validations_removed: validationIds.length },
    })
    await tx.insert(t.outbox).values({
      aggregate: 'subject',
      aggregateId: subjectId,
      eventType: 'subject.erased',
      payload: {
        tenant_id: tenantId,
        subject_id: subjectId,
        validations_removed: validationIds.length,
      },
    })
    return validationIds.length
  })
