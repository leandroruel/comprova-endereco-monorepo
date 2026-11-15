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
 * Protocolo de lock (mesmo do intake F1.1 e do worker F4.3): a linha da
 * `validation` é travada com `FOR UPDATE` como PRIMEIRO lock, ANTES da
 * descoberta, e só é liberada no commit — depois do storage e das linhas.
 * Como todo caminho que cria artefato/recibo/associação trava a mesma linha
 * antes de escrever (e verifica `expires_at`), nenhuma criação pode se
 * intrometer entre a descoberta e a exclusão: quem chegou antes é descoberto
 * aqui; quem chega depois encontra a validation removida (ou expirada) e não
 * cria nada. A ordem de aquisição é única (validation primeiro), sem
 * inversão que leve a deadlock.
 *
 * F0.1/ADR-0035: o objeto sai do storage ANTES do commit das linhas. Tudo
 * acontece na MESMA transação: se qualquer delete de objeto falhar, as linhas
 * NÃO são apagadas (rollback) e a validation continua elegível para o próximo
 * tick — `store.delete` é idempotente. Quando o commit ocorre, objeto e linhas
 * somem juntos; não sobra linha apontando para objeto inexistente nem objeto
 * que escape da retenção.
 */
const deleteValidationGraph = async (
  db: Db,
  validation: ExpiredValidation,
  store: ObjectStore,
): Promise<void> => {
  const { validationId, tenantId } = validation

  await db.transaction(async (tx) => {
    // Mesmo lock dos caminhos de criação (F1.1/worker/API), na mesma ordem.
    const locked = await tx
      .select({ validationId: t.validation.validationId })
      .from(t.validation)
      .where(and(eq(t.validation.validationId, validationId), eq(t.validation.tenantId, tenantId)))
      .for('update')
      .limit(1)
    // Já removida por execução concorrente da retenção: no-op idempotente.
    if (locked.length === 0) return

    const claims = await tx
      .select({ claimId: t.claim.claimId })
      .from(t.claim)
      .where(and(eq(t.claim.validationId, validationId), eq(t.claim.tenantId, tenantId)))

    const claimIds = claims.map((claim) => claim.claimId)
    const claimEvidences =
      claimIds.length === 0
        ? []
        : await tx
            .select({ claimEvidenceId: t.claimEvidence.claimEvidenceId })
            .from(t.claimEvidence)
            .where(inArray(t.claimEvidence.claimId, claimIds))

    // A relação explícita recibo ↔ Validation também identifica o documento do
    // Holder. Mantém a remoção correta mesmo se o recibo estiver órfão de claim.
    const linkedReceipts = await tx
      .select({ claimEvidenceId: t.validationCustomerDocument.claimEvidenceId })
      .from(t.validationCustomerDocument)
      .where(
        and(
          eq(t.validationCustomerDocument.validationId, validationId),
          eq(t.validationCustomerDocument.tenantId, tenantId),
        ),
      )

    const receiptIds = [
      ...new Set([
        ...claimEvidences.map((row) => row.claimEvidenceId),
        ...linkedReceipts.map((row) => row.claimEvidenceId),
      ]),
    ]

    // Três caminhos de artefato: upload direto F1.1 (`claim_evidence_id`),
    // documento do Holder associado por `evidence_artifact_claim_evidence` e
    // documento do Holder ainda NÃO associado — vinculado apenas à
    // `holder_information_request` da validation (ex.: segunda submissão quando
    // o recibo já tem artefato direto).
    const directArtifacts =
      receiptIds.length === 0
        ? []
        : await tx
            .select({
              artifactId: t.evidenceArtifact.artifactId,
              storageKey: t.evidenceArtifact.storageKey,
            })
            .from(t.evidenceArtifact)
            .where(inArray(t.evidenceArtifact.claimEvidenceId, receiptIds))

    const linkedArtifacts =
      receiptIds.length === 0
        ? []
        : await tx
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

    const holderRequestArtifacts = await tx
      .select({
        artifactId: t.evidenceArtifact.artifactId,
        storageKey: t.evidenceArtifact.storageKey,
      })
      .from(t.evidenceArtifact)
      .innerJoin(
        t.holderInformationRequest,
        and(
          eq(t.holderInformationRequest.id, t.evidenceArtifact.holderInformationRequestId),
          eq(t.holderInformationRequest.tenantId, t.evidenceArtifact.tenantId),
        ),
      )
      .where(
        and(
          eq(t.holderInformationRequest.validationId, validationId),
          eq(t.holderInformationRequest.tenantId, tenantId),
        ),
      )

    const artifacts = [...directArtifacts, ...linkedArtifacts, ...holderRequestArtifacts].filter(
      (artifact, index, all) => all.findIndex((other) => other.artifactId === artifact.artifactId) === index,
    )

    // O objeto sai antes do commit das linhas. Se um delete falhar, a
    // transação inteira é desfeita e a validation continua elegível para o
    // próximo tick (o delete no storage é idempotente).
    for (const artifact of artifacts) {
      await store.delete(artifact.storageKey)
    }

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
      .where(
        and(
          eq(t.validationCustomerDocument.validationId, validationId),
          eq(t.validationCustomerDocument.tenantId, tenantId),
        ),
      )

    // Mesmo padrão da erasure do subject: desvincula as solicitações do Holder
    // antes de excluir a validation, para que processamentos futuros as tratem
    // como não vinculadas (domínio Holder) em vez de apontarem para uma
    // validation removida.
    await tx
      .update(t.holderInformationRequest)
      .set({ validationId: null })
      .where(
        and(
          eq(t.holderInformationRequest.validationId, validationId),
          eq(t.holderInformationRequest.tenantId, tenantId),
        ),
      )

    if (receiptIds.length > 0) {
      await tx.delete(t.claimEvidence).where(inArray(t.claimEvidence.claimEvidenceId, receiptIds))
    }
    await tx
      .delete(t.claim)
      .where(and(eq(t.claim.validationId, validationId), eq(t.claim.tenantId, tenantId)))

    await tx.delete(t.signal).where(eq(t.signal.validationId, validationId))
    await tx
      .delete(t.validationIdempotency)
      .where(
        and(
          eq(t.validationIdempotency.validationId, validationId),
          eq(t.validationIdempotency.tenantId, tenantId),
        ),
      )
    await tx
      .delete(t.validation)
      .where(and(eq(t.validation.validationId, validationId), eq(t.validation.tenantId, tenantId)))
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
