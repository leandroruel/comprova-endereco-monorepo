import { and, eq, inArray, lte } from '@comprova/db'
import type { Db, DbTx } from '@comprova/db'
import * as t from '@comprova/db'
import type { Logger } from '@comprova/observability'
import type { ObjectStore } from '@comprova/providers'

interface ExpiredValidation {
  readonly validationId: string
  readonly tenantId: string
}

const recordExpirationAudit = async (
  tx: DbTx,
  validation: ExpiredValidation,
  artifactsRemoved: number,
): Promise<void> => {
  await tx.insert(t.auditLog).values({
    tenantId: validation.tenantId,
    actor: 'system:retention',
    action: 'validation.expired',
    targetType: 'validation',
    targetId: validation.validationId,
    details: {
      removed: 1,
      artifacts_removed: artifactsRemoved,
    },
  })
}

/**
 * ALTO-1: a retenção remove o grafo inteiro da validation como uma unidade
 * lógica, respeitando dependências:
 *   evidence_artifact -> claim_evidence -> claim -> signal / validation
 * `subject` e `canonical_address` possuem ciclo de vida próprio e NÃO são
 * removidos aqui (ver ADR de retenção).
 *
 * F0.1/ADR-0035: o artefato físico (PII de cliente) é removido do object
 * storage ANTES da linha, e a linha antes de `claim_evidence` (FK RESTRICT).
 * Se o storage falhar, a remoção para antes de apagar as linhas e o tick
 * tenta de novo na próxima execução.
 */
const deleteValidationGraph = async (
  db: Db,
  validation: ExpiredValidation,
  store: ObjectStore,
): Promise<void> => {
  const { validationId } = validation
  const claims = await db
    .select({ claimId: t.claim.claimId })
    .from(t.claim)
    .where(eq(t.claim.validationId, validationId))

  const artifacts =
    claims.length === 0
      ? []
      : await db
          .select({
            artifactId: t.evidenceArtifact.artifactId,
            storageKey: t.evidenceArtifact.storageKey,
          })
          .from(t.evidenceArtifact)
          .innerJoin(
            t.claimEvidence,
            and(
              eq(t.evidenceArtifact.claimEvidenceId, t.claimEvidence.claimEvidenceId),
              eq(t.evidenceArtifact.tenantId, t.claimEvidence.tenantId),
            ),
          )
          .innerJoin(t.claim, eq(t.claimEvidence.claimId, t.claim.claimId))
          .where(eq(t.claim.validationId, validationId))

  // O objeto sai antes da linha. Se um delete falhar, a transação de banco
  // abaixo nem começa e a validation continua elegível para o próximo tick.
  for (const artifact of artifacts) {
    await store.delete(artifact.storageKey)
  }

  await db.transaction(async (tx) => {
    if (artifacts.length > 0) {
      await tx.delete(t.evidenceArtifact).where(
        inArray(
          t.evidenceArtifact.artifactId,
          artifacts.map((artifact) => artifact.artifactId),
        ),
      )
    }

    if (claims.length > 0) {
      await tx.delete(t.claimEvidence).where(
        inArray(
          t.claimEvidence.claimId,
          claims.map((claim) => claim.claimId),
        ),
      )
      await tx.delete(t.claim).where(eq(t.claim.validationId, validationId))
    }

    await tx.delete(t.signal).where(eq(t.signal.validationId, validationId))
    await tx.delete(t.validationIdempotency).where(eq(t.validationIdempotency.validationId, validationId))
    await tx.delete(t.validation).where(eq(t.validation.validationId, validationId))
    await recordExpirationAudit(tx, validation, artifacts.length)
  })
}

export const validationRetentionTick = async (
  db: Db,
  store: ObjectStore,
  limit = 200,
  logger?: Logger,
): Promise<number> => {
  const expired = await db
    .select({
      validationId: t.validation.validationId,
      tenantId: t.validation.tenantId,
    })
    .from(t.validation)
    .where(lte(t.validation.expiresAt, new Date()))
    .limit(limit)

  if (expired.length === 0) return 0

  let removed = 0

  for (const row of expired) {
    try {
      await deleteValidationGraph(db, row, store)
      removed += 1
    } catch (error) {
      // A linha continua expirada e será tentada de novo no próximo tick. A
      // falha de uma validation não impede a remoção das demais.
      logger?.warn(
        {
          validation_id: row.validationId,
          reason: 'RETENTION_DELETE_FAILED',
          error_name: error instanceof Error ? error.name : 'unknown',
          error_message: error instanceof Error ? error.message : String(error),
        },
        'validation retention failed; will retry next tick',
      )
    }
  }

  return removed
}
