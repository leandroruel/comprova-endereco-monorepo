import { and, eq, inArray, lte, type Db, type DbTx } from '@comprova/db'
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

  const claimIds = claims.map((claim) => claim.claimId)
  const claimEvidences =
    claimIds.length === 0
      ? []
      : await db
          .select({ claimEvidenceId: t.claimEvidence.claimEvidenceId })
          .from(t.claimEvidence)
          .where(inArray(t.claimEvidence.claimId, claimIds))

  // A relação explícita recibo ↔ Validation também identifica o documento do
  // Holder. Mantém a remoção correta mesmo se o recibo estiver órfão de claim.
  const linkedReceipts = await db
    .select({ claimEvidenceId: t.validationCustomerDocument.claimEvidenceId })
    .from(t.validationCustomerDocument)
    .where(eq(t.validationCustomerDocument.validationId, validationId))

  const receiptIds = [
    ...new Set([
      ...claimEvidences.map((row) => row.claimEvidenceId),
      ...linkedReceipts.map((row) => row.claimEvidenceId),
    ]),
  ]

  // Dois caminhos de artefato: upload direto F1.1 (`claim_evidence_id`) e
  // documento do Holder associado por `evidence_artifact_claim_evidence`.
  const directArtifacts =
    receiptIds.length === 0
      ? []
      : await db
          .select({
            artifactId: t.evidenceArtifact.artifactId,
            storageKey: t.evidenceArtifact.storageKey,
          })
          .from(t.evidenceArtifact)
          .where(inArray(t.evidenceArtifact.claimEvidenceId, receiptIds))

  const linkedArtifacts =
    receiptIds.length === 0
      ? []
      : await db
          .select({
            artifactId: t.evidenceArtifact.artifactId,
            storageKey: t.evidenceArtifact.storageKey,
          })
          .from(t.evidenceArtifact)
          .innerJoin(
            t.evidenceArtifactClaimEvidence,
            and(
              eq(t.evidenceArtifactClaimEvidence.artifactId, t.evidenceArtifact.artifactId),
              eq(t.evidenceArtifactClaimEvidence.tenantId, t.evidenceArtifact.tenantId),
            ),
          )
          .where(inArray(t.evidenceArtifactClaimEvidence.claimEvidenceId, receiptIds))

  const artifacts = [...directArtifacts, ...linkedArtifacts].filter(
    (artifact, index, all) => all.findIndex((other) => other.artifactId === artifact.artifactId) === index,
  )

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

    await tx
      .delete(t.validationCustomerDocument)
      .where(eq(t.validationCustomerDocument.validationId, validationId))

    if (receiptIds.length > 0) {
      await tx.delete(t.claimEvidence).where(inArray(t.claimEvidence.claimEvidenceId, receiptIds))
    }
    await tx.delete(t.claim).where(eq(t.claim.validationId, validationId))

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
