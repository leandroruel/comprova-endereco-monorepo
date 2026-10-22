import { eq, inArray, lte } from '@comprova/db'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
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
  validationIds: readonly string[],
  store: ObjectStore,
): Promise<DeletionStats> => {
  const artifactsByTenant = new Map<string, number>()
  const claims = await db
    .select({ claimId: t.claim.claimId })
    .from(t.claim)
    .where(inArray(t.claim.validationId, [...validationIds]))

  if (claims.length > 0) {
    const artifacts = await db
      .select({
        artifactId: t.evidenceArtifact.artifactId,
        storageKey: t.evidenceArtifact.storageKey,
        tenantId: t.evidenceArtifact.tenantId,
      })
      .from(t.evidenceArtifact)
      .innerJoin(t.claimEvidence, eq(t.evidenceArtifact.claimEvidenceId, t.claimEvidence.claimEvidenceId))
      .innerJoin(t.claim, eq(t.claimEvidence.claimId, t.claim.claimId))
      .where(inArray(t.claim.validationId, [...validationIds]))

    for (const artifact of artifacts) {
      await store.delete(artifact.storageKey)
      artifactsByTenant.set(artifact.tenantId, (artifactsByTenant.get(artifact.tenantId) ?? 0) + 1)
    }

    if (artifacts.length > 0) {
      await db.delete(t.evidenceArtifact).where(
        inArray(
          t.evidenceArtifact.artifactId,
          artifacts.map((artifact) => artifact.artifactId),
        ),
      )
    }

    await db.delete(t.claimEvidence).where(
      inArray(
        t.claimEvidence.claimId,
        claims.map((claim) => claim.claimId),
      ),
    )
    await db.delete(t.claim).where(inArray(t.claim.validationId, [...validationIds]))
  }

  await db.delete(t.signal).where(inArray(t.signal.validationId, [...validationIds]))
  await db
    .delete(t.validationIdempotency)
    .where(inArray(t.validationIdempotency.validationId, [...validationIds]))
  await db.delete(t.validation).where(inArray(t.validation.validationId, [...validationIds]))

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

export const validationRetentionTick = async (db: Db, store: ObjectStore, limit = 200): Promise<number> => {
  const expired = await db
    .select({
      validationId: t.validation.validationId,
      tenantId: t.validation.tenantId,
    })
    .from(t.validation)
    .where(lte(t.validation.expiresAt, new Date()))
    .limit(limit)

  if (expired.length === 0) return 0

  const { artifactsByTenant } = await deleteValidationGraph(
    db,
    expired.map((row) => row.validationId),
    store,
  )
  await recordExpirationAudit(db, expired, artifactsByTenant)
  return expired.length
}
