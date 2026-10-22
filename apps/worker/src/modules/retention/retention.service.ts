import { and, eq, inArray, lte } from '@comprova/db'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import type { Logger } from '@comprova/observability'
import type { ObjectStore } from '@comprova/providers'

interface ExpiredValidation {
  readonly validationId: string
  readonly tenantId: string
}

interface DeletionStats {
  readonly artifactsByTenant: ReadonlyMap<string, number>
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
  validationId: string,
  store: ObjectStore,
): Promise<DeletionStats> => {
  const artifactsByTenant = new Map<string, number>()
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
            tenantId: t.evidenceArtifact.tenantId,
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
    artifactsByTenant.set(artifact.tenantId, (artifactsByTenant.get(artifact.tenantId) ?? 0) + 1)
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
  })

  return { artifactsByTenant }
}

const recordExpirationAudit = async (
  db: Db,
  expired: readonly ExpiredValidation[],
  artifactsByTenant: ReadonlyMap<string, number>,
): Promise<void> => {
  const tenants = [...new Set(expired.map((row) => row.tenantId))]
  await db.insert(t.auditLog).values(
    tenants.map((tenantId) => ({
      tenantId,
      actor: 'system:retention',
      action: 'validation.expired',
      targetType: 'validation',
      targetId: 'batch',
      details: {
        removed: expired.filter((row) => row.tenantId === tenantId).length,
        artifacts_removed: artifactsByTenant.get(tenantId) ?? 0,
      },
    })),
  )
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

  const removed: ExpiredValidation[] = []
  const artifactsByTenant = new Map<string, number>()

  for (const row of expired) {
    try {
      const stats = await deleteValidationGraph(db, row.validationId, store)
      removed.push(row)
      for (const [tenantId, count] of stats.artifactsByTenant) {
        artifactsByTenant.set(tenantId, (artifactsByTenant.get(tenantId) ?? 0) + count)
      }
    } catch (error) {
      // A linha continua expirada e será tentada de novo no próximo tick. A
      // falha de uma validation não impede a remoção das demais.
      logger?.warn(
        {
          validation_id: row.validationId,
          reason: 'RETENTION_DELETE_FAILED',
          error_name: error instanceof Error ? error.name : 'unknown',
        },
        'validation retention failed; will retry next tick',
      )
    }
  }

  if (removed.length > 0) {
    await recordExpirationAudit(db, removed, artifactsByTenant)
  }
  return removed.length
}
