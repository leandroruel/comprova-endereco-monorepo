import {
  CUSTOMER_DOCUMENT_INTAKE_CHECKER,
  CUSTOMER_DOCUMENT_INTAKE_CHECKER_VERSION,
  CUSTOMER_DOCUMENT_INTAKE_SOURCE,
  CUSTOMER_DOCUMENT_INTAKE_STATUS,
} from '@comprova/core'
import {
  and,
  eq,
  insertPendingEvidenceAnalysis,
  isNull,
  sql,
  withTenant,
  type Db,
  type DbTx,
} from '@comprova/db'
import * as t from '@comprova/db'
import { randomUUID } from 'node:crypto'
import type { Logger } from '@comprova/observability'
import type { ObjectStoreReader } from '@comprova/providers'

const errorNameOf = (error: unknown): string => (error instanceof Error ? error.name : 'unknown')

export interface HolderSubmissionProcessingWorkerDeps {
  readonly db: Db
  readonly store: ObjectStoreReader
  readonly logger: Logger
  readonly batchSize?: number
  readonly now?: () => Date
}

const DEFAULT_BATCH_SIZE = 10

interface StoredDocumentRow {
  readonly documentId: string
  readonly storageKey: string
  readonly itemId: string
  readonly contentType: string | null
  readonly sizeBytes: number | null
  readonly sha256: Buffer | null
}

interface MaterializedArtifact {
  readonly artifactId: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: Buffer
}

interface ValidationForClaim {
  readonly validationId: string
  readonly tenantId: string
  readonly subjectId: string
  readonly addressId: string | null
  readonly expiresAt: Date
}

interface ClaimTarget {
  readonly validation: ValidationForClaim
  readonly claimId: string
  /** Recibo `customer_submitted_document` já existente para a Validation. */
  readonly existingReceiptId: string | null
}

/**
 * Carrega (e trava) a validation vinculada à solicitação. O `FOR UPDATE` usa a
 * mesma ordem do intake F1.1: upload direto e submissão do Holder serializam na
 * linha da validation antes de criar claim/recibo. `validation` é particionada
 * por `created_at`, mas o lock de linha continua válido.
 */
const loadValidationForClaim = async (
  tx: DbTx,
  tenantId: string,
  validationId: string,
): Promise<ValidationForClaim | undefined> => {
  const rows = await tx
    .select({
      validationId: t.validation.validationId,
      tenantId: t.validation.tenantId,
      subjectId: t.validation.subjectId,
      addressId: t.validation.addressId,
      expiresAt: t.validation.expiresAt,
    })
    .from(t.validation)
    .where(and(eq(t.validation.validationId, validationId), eq(t.validation.tenantId, tenantId)))
    .for('update')
    .limit(1)
  return rows[0]
}

/**
 * Procura o recibo de intake já existente para QUALQUER claim da validation.
 *
 * A busca é por validation (e não só pelo claim) porque uma validation pode ter
 * mais de um `claim` de tipos diferentes. O recibo é único por claim no banco;
 * localizá-lo antes de escolher o claim garante que o fluxo do Holder reutilize
 * o mesmo recibo que o F1.1 eventualmente criou.
 */
const loadExistingReceipt = async (
  tx: DbTx,
  tenantId: string,
  validationId: string,
): Promise<{ readonly claimId: string; readonly claimEvidenceId: string } | undefined> => {
  const rows = await tx
    .select({
      claimId: t.claimEvidence.claimId,
      claimEvidenceId: t.claimEvidence.claimEvidenceId,
    })
    .from(t.claimEvidence)
    .innerJoin(
      t.claim,
      and(eq(t.claim.claimId, t.claimEvidence.claimId), eq(t.claim.tenantId, t.claimEvidence.tenantId)),
    )
    .where(
      and(
        eq(t.claim.tenantId, tenantId),
        eq(t.claim.validationId, validationId),
        eq(t.claimEvidence.source, CUSTOMER_DOCUMENT_INTAKE_SOURCE),
      ),
    )
    .limit(1)
  return rows[0]
}

/**
 * Localiza ou cria o claim da validation seguindo as mesmas regras do F1.1
 * (`ensureClaim`): reutiliza o claim existente; senão deriva tipo/subjectType do
 * `subject.docType` e insere com `ON CONFLICT DO NOTHING`. Nenhuma comparação
 * de identidade é feita aqui.
 */
const ensureClaimForValidation = async (tx: DbTx, validation: ValidationForClaim): Promise<ClaimTarget> => {
  const receipt = await loadExistingReceipt(tx, validation.tenantId, validation.validationId)
  if (receipt !== undefined) {
    return { validation, claimId: receipt.claimId, existingReceiptId: receipt.claimEvidenceId }
  }

  const existingClaim = await tx
    .select({ claimId: t.claim.claimId })
    .from(t.claim)
    .where(and(eq(t.claim.tenantId, validation.tenantId), eq(t.claim.validationId, validation.validationId)))
    .limit(1)
  if (existingClaim[0] !== undefined) {
    return { validation, claimId: existingClaim[0].claimId, existingReceiptId: null }
  }

  const subjectRows = await tx
    .select({ docType: t.subject.docType })
    .from(t.subject)
    .where(and(eq(t.subject.subjectId, validation.subjectId), eq(t.subject.tenantId, validation.tenantId)))
    .limit(1)
  const docType = subjectRows[0]?.docType
  if (docType === undefined) throw new Error('validation subject missing')

  await tx
    .insert(t.claim)
    .values({
      claimId: randomUUID(),
      tenantId: validation.tenantId,
      validationId: validation.validationId,
      subjectId: validation.subjectId,
      addressId: validation.addressId,
      type: docType === 'CNPJ' ? 'business_registered_address' : 'address_exists',
      subjectType: docType === 'CNPJ' ? 'organization' : 'person',
      targetType: 'address',
    })
    .onConflictDoNothing()

  const created = await tx
    .select({ claimId: t.claim.claimId })
    .from(t.claim)
    .where(and(eq(t.claim.tenantId, validation.tenantId), eq(t.claim.validationId, validation.validationId)))
    .limit(1)
  if (created[0] === undefined) throw new Error('claim insert failed')
  return { validation, claimId: created[0].claimId, existingReceiptId: null }
}

/**
 * Cria (ou reutiliza) o recibo `customer_submitted_document` para o claim.
 *
 * Valores idênticos ao F1.1: o upload/submissão só prova que um documento foi
 * apresentado. `stance = unknown`, `strength = 0`, `confidence = 0` e detalhe
 * `pending`. Nenhum resultado de análise ou aprovação é antecipado.
 *
 * `ON CONFLICT DO NOTHING` cobre replay/retry e a corrida com outra submissão
 * da mesma validation; o índice parcial de `claim_evidence` é a barreira do
 * banco. O `detail.origin` preserva a solicitação/documento/artefato que
 * originou o recibo, sem copiar PII.
 */
const ensureCustomerDocumentReceipt = async (
  tx: DbTx,
  input: {
    readonly tenantId: string
    readonly claimId: string
    readonly validation: ValidationForClaim
    readonly requestId: string
    readonly documentId: string
    readonly artifact: MaterializedArtifact
    readonly now: Date
  },
): Promise<string> => {
  const existing = await tx
    .select({ claimEvidenceId: t.claimEvidence.claimEvidenceId })
    .from(t.claimEvidence)
    .where(
      and(
        eq(t.claimEvidence.claimId, input.claimId),
        eq(t.claimEvidence.tenantId, input.tenantId),
        eq(t.claimEvidence.source, CUSTOMER_DOCUMENT_INTAKE_SOURCE),
      ),
    )
    .limit(1)
  if (existing[0] !== undefined) return existing[0].claimEvidenceId

  const ttlSeconds = Math.max(
    0,
    Math.floor((input.validation.expiresAt.getTime() - input.now.getTime()) / 1000),
  )
  const [inserted] = await tx
    .insert(t.claimEvidence)
    .values({
      claimEvidenceId: randomUUID(),
      tenantId: input.tenantId,
      claimId: input.claimId,
      signalId: null,
      evidenceId: null,
      evidenceSha256: input.artifact.sha256,
      checker: CUSTOMER_DOCUMENT_INTAKE_CHECKER,
      checkerVersion: CUSTOMER_DOCUMENT_INTAKE_CHECKER_VERSION,
      stance: 'unknown',
      strength: 0,
      confidence: 0,
      source: CUSTOMER_DOCUMENT_INTAKE_SOURCE,
      observedAt: input.now,
      ttlSeconds,
      expiresAt: input.validation.expiresAt,
      detail: {
        verification: {
          status: CUSTOMER_DOCUMENT_INTAKE_STATUS,
          method: 'content_intake',
          document: null,
          address: null,
          holder: null,
        },
        artifact: {
          content_type: input.artifact.contentType,
          size_bytes: input.artifact.sizeBytes,
        },
        origin: {
          holder_information_request_id: input.requestId,
          holder_information_request_document_id: input.documentId,
          evidence_artifact_id: input.artifact.artifactId,
        },
      },
    })
    .onConflictDoNothing()
    .returning({ claimEvidenceId: t.claimEvidence.claimEvidenceId })

  if (inserted !== undefined) return inserted.claimEvidenceId

  // Outra transação venceu o índice único: relê o recibo já commitado.
  const [after] = await tx
    .select({ claimEvidenceId: t.claimEvidence.claimEvidenceId })
    .from(t.claimEvidence)
    .where(
      and(
        eq(t.claimEvidence.claimId, input.claimId),
        eq(t.claimEvidence.tenantId, input.tenantId),
        eq(t.claimEvidence.source, CUSTOMER_DOCUMENT_INTAKE_SOURCE),
      ),
    )
    .limit(1)
  if (after === undefined) throw new Error('customer document receipt insert failed')
  return after.claimEvidenceId
}

/**
 * Associa o artefato do Holder ao recibo da Claim.
 *
 * Se o recibo já tem um artefato direto (upload F1.1), não cria vínculo: a
 * Validation já tem seu documento e a segunda tentativa deve conflitar, não
 * duplicar. `ON CONFLICT DO NOTHING` cobre replay/retry e a corrida entre duas
 * solicitações: o UNIQUE de `claim_evidence_id` mantém 1 artefato por recibo.
 */
const linkArtifactToReceipt = async (
  tx: DbTx,
  input: {
    readonly tenantId: string
    readonly artifactId: string
    readonly claimEvidenceId: string
  },
): Promise<void> => {
  const directArtifact = await tx
    .select({ artifactId: t.evidenceArtifact.artifactId })
    .from(t.evidenceArtifact)
    .where(
      and(
        eq(t.evidenceArtifact.tenantId, input.tenantId),
        eq(t.evidenceArtifact.claimEvidenceId, input.claimEvidenceId),
      ),
    )
    .limit(1)
  if (directArtifact[0] !== undefined) return

  await tx
    .insert(t.evidenceArtifactClaimEvidence)
    .values({
      artifactId: input.artifactId,
      claimEvidenceId: input.claimEvidenceId,
      tenantId: input.tenantId,
      createdAt: sql`clock_timestamp()`,
    })
    .onConflictDoNothing()
}

/**
 * Cria (ou reutiliza) o artefato do documento do Holder. O objeto é o MESMO
 * `storage_key` gravado pela F4.2; nenhum byte é copiado. `ON CONFLICT DO
 * NOTHING` + releitura tornam replay/retry e duas execuções concorrentes
 * idempotentes em vez de contarem como falha.
 */
const ensureArtifact = async (
  tx: DbTx,
  input: {
    readonly tenantId: string
    readonly requestId: string
    readonly document: StoredDocumentRow
    readonly retentionUntil: Date
  },
): Promise<MaterializedArtifact> => {
  const [existing] = await tx
    .select({
      artifactId: t.evidenceArtifact.artifactId,
      contentType: t.evidenceArtifact.contentType,
      sizeBytes: t.evidenceArtifact.sizeBytes,
      sha256: t.evidenceArtifact.sha256,
    })
    .from(t.evidenceArtifact)
    .where(
      and(
        eq(t.evidenceArtifact.holderInformationRequestId, input.requestId),
        eq(t.evidenceArtifact.tenantId, input.tenantId),
        eq(t.evidenceArtifact.storageKey, input.document.storageKey),
      ),
    )
    .limit(1)
  if (existing !== undefined) {
    return {
      artifactId: existing.artifactId,
      contentType: existing.contentType,
      sizeBytes: existing.sizeBytes,
      sha256: Buffer.from(existing.sha256),
    }
  }

  if (
    input.document.contentType === null ||
    input.document.sizeBytes === null ||
    input.document.sha256 === null
  ) {
    throw new Error('holder document without stored metadata')
  }

  const artifactId = randomUUID()
  const [inserted] = await tx
    .insert(t.evidenceArtifact)
    .values({
      artifactId,
      tenantId: input.tenantId,
      claimEvidenceId: null,
      holderInformationRequestId: input.requestId,
      storageKey: input.document.storageKey,
      contentType: input.document.contentType,
      sizeBytes: input.document.sizeBytes,
      sha256: input.document.sha256,
      retentionUntil: input.retentionUntil,
    })
    .onConflictDoNothing()
    .returning({ artifactId: t.evidenceArtifact.artifactId })

  if (inserted !== undefined) {
    return {
      artifactId: inserted.artifactId,
      contentType: input.document.contentType,
      sizeBytes: input.document.sizeBytes,
      sha256: Buffer.from(input.document.sha256),
    }
  }

  const [after] = await tx
    .select({
      artifactId: t.evidenceArtifact.artifactId,
      contentType: t.evidenceArtifact.contentType,
      sizeBytes: t.evidenceArtifact.sizeBytes,
      sha256: t.evidenceArtifact.sha256,
    })
    .from(t.evidenceArtifact)
    .where(
      and(
        eq(t.evidenceArtifact.holderInformationRequestId, input.requestId),
        eq(t.evidenceArtifact.tenantId, input.tenantId),
        eq(t.evidenceArtifact.storageKey, input.document.storageKey),
      ),
    )
    .limit(1)
  if (after === undefined) throw new Error('holder artifact insert failed')
  return {
    artifactId: after.artifactId,
    contentType: after.contentType,
    sizeBytes: after.sizeBytes,
    sha256: Buffer.from(after.sha256),
  }
}

/**
 * F4.3 — loop de processamento de submissões do Holder.
 *
 * Consome eventos de outbox `holder_submission.processing_requested` e executa
 * o processamento documental para cada submissão concluída pelo Holder.
 *
 * Quando a solicitação está vinculada a uma validation (PR #72), o mesmo
 * documento passa a participar do pipeline existente:
 *   holder_information_request → validation → claim →
 *   claim_evidence (recibo `customer_submitted_document`) →
 *   evidence_artifact → evidence_analysis (F1.2) → verificação F1.3.
 *
 * O artefato continua pertencendo à solicitação (`holder_information_request_id`)
 * e o vínculo com o recibo é feito na tabela aditiva
 * `evidence_artifact_claim_evidence`. Não há pipeline paralelo, cópia de bytes,
 * fila nova nem alteração de score/veredito.
 *
 * Segue o mesmo padrão de `analyzeEvidenceTick`:
 *   - Lê eventos não publicados do outbox com FOR UPDATE SKIP LOCKED
 *   - Marca como publicados após o processamento
 *   - Cada submissão é processada com seu próprio tenant via withTenant
 *   - Idempotente: reprocessar não duplica artefatos, análises, recibos nem
 *     vínculos
 *
 * Não cria uma segunda fila: reutiliza o outbox transacional existente
 * (ADR-0002).
 */
export const holderSubmissionProcessingTick = async (
  deps: HolderSubmissionProcessingWorkerDeps,
): Promise<number> => {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE
  const now = (deps.now ?? (() => new Date()))()
  let processed = 0

  const events = (await deps.db.execute(sql`
    SELECT outbox_id, payload
    FROM outbox
    WHERE aggregate = 'holder_information_request'
      AND event_type = 'holder_submission.processing_requested'
      AND published_at IS NULL
    ORDER BY outbox_id
    LIMIT ${batchSize}
    FOR UPDATE SKIP LOCKED
  `)) as unknown as readonly {
    outbox_id: number
    payload: {
      holder_information_request_id: string
      tenant_id: string
    }
  }[]

  for (const event of events) {
    const { outbox_id: outboxId } = event
    const { holder_information_request_id: requestId, tenant_id: tenantId } = event.payload

    try {
      await withTenant(deps.db, tenantId, async (tx) => {
        // Verifica se o registro de processamento já existe e está em estado
        // terminal. Se sim, marca o outbox como publicado e segue.
        const existing = await tx
          .select({ state: t.holderSubmissionProcessing.state })
          .from(t.holderSubmissionProcessing)
          .where(
            and(
              eq(t.holderSubmissionProcessing.holderInformationRequestId, requestId),
              eq(t.holderSubmissionProcessing.tenantId, tenantId),
            ),
          )
          .for('update')
          .limit(1)

        const row = existing[0]
        if (row) {
          const state = row.state as 'awaiting' | 'processing' | 'processed' | 'partial' | 'failed'
          if (state === 'processed' || state === 'failed') {
            await tx
              .update(t.outbox)
              .set({ publishedAt: sql`clock_timestamp()` })
              .where(eq(t.outbox.outboxId, outboxId))
            return
          }
        }

        // Lista documentos ativos da solicitação. A ordem é determinística para
        // que a escolha do documento que lastreia o recibo seja estável entre
        // retries (apenas um documento por Validation nesta etapa).
        const documents = (await tx
          .select({
            documentId: t.holderInformationRequestDocument.documentId,
            storageKey: t.holderInformationRequestDocument.storageKey,
            itemId: t.holderInformationRequestDocument.itemId,
            contentType: t.holderInformationRequestDocument.contentType,
            sizeBytes: t.holderInformationRequestDocument.sizeBytes,
            sha256: t.holderInformationRequestDocument.sha256,
            createdAt: t.holderInformationRequestDocument.createdAt,
          })
          .from(t.holderInformationRequestDocument)
          .where(
            and(
              eq(t.holderInformationRequestDocument.holderInformationRequestId, requestId),
              eq(t.holderInformationRequestDocument.tenantId, tenantId),
              eq(t.holderInformationRequestDocument.uploadState, 'stored'),
              isNull(t.holderInformationRequestDocument.deletedAt),
            ),
          )
          .orderBy(
            t.holderInformationRequestDocument.createdAt,
            t.holderInformationRequestDocument.documentId,
          )) as readonly (StoredDocumentRow & { readonly createdAt: Date })[]

        if (documents.length === 0) {
          // Sem documentos: marca como processado (nada a fazer).
          await tx
            .insert(t.holderSubmissionProcessing)
            .values({
              processingId: randomUUID(),
              holderInformationRequestId: requestId,
              tenantId,
              state: 'processed',
              attempts: 0,
              lastError: null,
              createdAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
              processedAt: sql`clock_timestamp()`,
            })
            .onConflictDoNothing()
          await tx
            .update(t.outbox)
            .set({ publishedAt: sql`clock_timestamp()` })
            .where(eq(t.outbox.outboxId, outboxId))
          return
        }

        // Resolve a Validation vinculada (PR #72). Solicitações antigas sem
        // vínculo continuam apenas com artefato + análise, como antes.
        const requestRow = await tx
          .select({ validationId: t.holderInformationRequest.validationId })
          .from(t.holderInformationRequest)
          .where(
            and(
              eq(t.holderInformationRequest.id, requestId),
              eq(t.holderInformationRequest.tenantId, tenantId),
            ),
          )
          .limit(1)

        let claimTarget: ClaimTarget | null = null
        const validationId = requestRow[0]?.validationId
        if (validationId !== null && validationId !== undefined) {
          const validation = await loadValidationForClaim(tx, tenantId, validationId)
          if (validation === undefined) {
            // Validation removida por erasure ou vínculo inconsistente: não
            // ressuscita evidência. O artefato do Holder segue o ciclo F4.3.
            deps.logger.warn(
              {
                request_id: requestId,
                tenant_id: tenantId,
                validation_id: validationId,
                reason: 'HOLDER_VALIDATION_NOT_FOUND',
              },
              'holder request validation not found; skipping claim materialization',
            )
          } else {
            claimTarget = await ensureClaimForValidation(tx, validation)
          }
        }

        let failedCount = 0
        let primaryArtifact: {
          readonly document: StoredDocumentRow
          readonly artifact: MaterializedArtifact
        } | null = null

        for (const doc of documents) {
          try {
            const artifact = await ensureArtifact(tx, {
              tenantId,
              requestId,
              document: doc,
              retentionUntil: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
            })

            // Insere análise pendente (idempotente por artifact+analyzer+versão+contrato).
            await insertPendingEvidenceAnalysis(tx, { tenantId, artifactId: artifact.artifactId, now })

            // Apenas o primeiro documento ativo é materializado como evidência
            // da Validation (1:1). Os demais continuam como documentos do
            // Holder, sem segundo recibo/vínculo.
            primaryArtifact ??= { document: doc, artifact }
          } catch (error) {
            failedCount += 1
            deps.logger.warn(
              {
                document_id: doc.documentId,
                request_id: requestId,
                tenant_id: tenantId,
                error_name: errorNameOf(error),
              },
              'holder submission document processing failed',
            )
          }
        }

        if (claimTarget !== null && primaryArtifact !== null) {
          const receiptId =
            claimTarget.existingReceiptId ??
            (await ensureCustomerDocumentReceipt(tx, {
              tenantId,
              claimId: claimTarget.claimId,
              validation: claimTarget.validation,
              requestId,
              documentId: primaryArtifact.document.documentId,
              artifact: primaryArtifact.artifact,
              now,
            }))

          await linkArtifactToReceipt(tx, {
            tenantId,
            artifactId: primaryArtifact.artifact.artifactId,
            claimEvidenceId: receiptId,
          })
        }

        const state = failedCount === documents.length ? 'failed' : failedCount > 0 ? 'partial' : 'processed'

        await tx
          .insert(t.holderSubmissionProcessing)
          .values({
            processingId: randomUUID(),
            holderInformationRequestId: requestId,
            tenantId,
            state,
            attempts: 1,
            lastError: failedCount > 0 ? `${failedCount} de ${documents.length} documento(s) falharam` : null,
            createdAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
            processedAt: sql`clock_timestamp()`,
          })
          .onConflictDoUpdate({
            target: [t.holderSubmissionProcessing.holderInformationRequestId],
            set: {
              state,
              attempts: sql`${t.holderSubmissionProcessing.attempts} + 1`,
              lastError:
                failedCount > 0 ? `${failedCount} de ${documents.length} documento(s) falharam` : null,
              updatedAt: sql`clock_timestamp()`,
              processedAt: sql`clock_timestamp()`,
            },
          })

        // Marca o outbox como publicado.
        await tx
          .update(t.outbox)
          .set({ publishedAt: sql`clock_timestamp()` })
          .where(eq(t.outbox.outboxId, outboxId))
      })

      processed += 1
    } catch (error) {
      deps.logger.error(
        {
          outbox_id: outboxId,
          request_id: requestId,
          tenant_id: tenantId,
          error_name: errorNameOf(error),
        },
        'holder submission processing tick item failed',
      )
    }
  }

  return processed
}
