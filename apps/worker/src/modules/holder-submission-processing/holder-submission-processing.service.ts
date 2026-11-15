import {
  CUSTOMER_DOCUMENT_INTAKE_CHECKER,
  CUSTOMER_DOCUMENT_INTAKE_CHECKER_VERSION,
  CUSTOMER_DOCUMENT_INTAKE_SOURCE,
  CUSTOMER_DOCUMENT_INTAKE_STATUS,
  addressClaimForSubjectDocType,
  type AddressClaimSpec,
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
 * Inconsistência de dados que impede materializar o recibo sem violar a regra
 * "um documento por Validation". Não é transitória: repetir o evento não muda
 * o resultado. O worker loga e segue com artefato/análise do Holder, sem
 * reaproveitar Claim/recibo de outra finalidade nem criar um segundo recibo.
 */
export class HolderClaimInconsistencyError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'HolderClaimInconsistencyError'
  }
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

const loadSubjectDocType = async (tx: DbTx, tenantId: string, subjectId: string): Promise<string> => {
  const rows = await tx
    .select({ docType: t.subject.docType })
    .from(t.subject)
    .where(and(eq(t.subject.subjectId, subjectId), eq(t.subject.tenantId, tenantId)))
    .limit(1)
  const docType = rows[0]?.docType
  if (docType === undefined) throw new Error('validation subject missing')
  return docType
}

/**
 * Claims da Validation que representam a MESMA finalidade de endereço derivada
 * do subject. Outras Claims da Validation (ex.: finalidade diferente) nunca são
 * candidatas. Duas candidatas iguais são inconsistência, não empate.
 */
const loadAddressClaimCandidates = async (
  tx: DbTx,
  validation: ValidationForClaim,
  spec: AddressClaimSpec,
): Promise<readonly { readonly claimId: string }[]> =>
  tx
    .select({ claimId: t.claim.claimId })
    .from(t.claim)
    .where(
      and(
        eq(t.claim.tenantId, validation.tenantId),
        eq(t.claim.validationId, validation.validationId),
        eq(t.claim.type, spec.type),
        eq(t.claim.subjectType, spec.subjectType),
      ),
    )

/**
 * Recibos `customer_submitted_document` de QUALQUER Claim da Validation.
 * Usado apenas para detectar dados legados/inconsistentes: o fluxo do Holder só
 * adota o recibo se ele estiver na Claim de endereço. Não é `.limit(1)` porque
 * duas linhas significam violação da regra "um documento por Validation".
 */
const loadReceiptsForValidation = async (
  tx: DbTx,
  tenantId: string,
  validationId: string,
): Promise<readonly { readonly claimId: string; readonly claimEvidenceId: string }[]> =>
  tx
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
    .orderBy(t.claimEvidence.createdAt, t.claimEvidence.claimEvidenceId)

const loadValidationCustomerDocument = async (
  tx: DbTx,
  tenantId: string,
  validationId: string,
): Promise<{ readonly claimId: string; readonly claimEvidenceId: string } | undefined> => {
  const [row] = await tx
    .select({
      claimEvidenceId: t.validationCustomerDocument.claimEvidenceId,
      claimId: t.claimEvidence.claimId,
    })
    .from(t.validationCustomerDocument)
    .innerJoin(
      t.claimEvidence,
      and(
        eq(t.claimEvidence.claimEvidenceId, t.validationCustomerDocument.claimEvidenceId),
        eq(t.claimEvidence.tenantId, t.validationCustomerDocument.tenantId),
      ),
    )
    .where(
      and(
        eq(t.validationCustomerDocument.tenantId, tenantId),
        eq(t.validationCustomerDocument.validationId, validationId),
      ),
    )
    .limit(1)
  return row
}

/**
 * Garante a relação 1:1 recibo ↔ Validation. `validation_id` é PK no banco:
 * se já houver outro recibo vinculado, a leitura detecta o conflito e o fluxo
 * não o reutiliza nem cria um segundo documento.
 */
const ensureValidationCustomerDocument = async (
  tx: DbTx,
  input: { readonly tenantId: string; readonly validationId: string; readonly claimEvidenceId: string },
): Promise<void> => {
  await tx
    .insert(t.validationCustomerDocument)
    .values({
      validationId: input.validationId,
      claimEvidenceId: input.claimEvidenceId,
      tenantId: input.tenantId,
      createdAt: sql`clock_timestamp()`,
    })
    .onConflictDoNothing()

  const [link] = await tx
    .select({ claimEvidenceId: t.validationCustomerDocument.claimEvidenceId })
    .from(t.validationCustomerDocument)
    .where(
      and(
        eq(t.validationCustomerDocument.tenantId, input.tenantId),
        eq(t.validationCustomerDocument.validationId, input.validationId),
      ),
    )
    .limit(1)

  if (link === undefined) throw new Error('validation customer document link insert failed')
  if (link.claimEvidenceId !== input.claimEvidenceId) {
    throw new HolderClaimInconsistencyError('validation_receipt_conflict')
  }
}

/**
 * Resolve a Claim de endereço da Validation e o recibo já existente.
 *
 * A finalidade vem do `subject.docType`, com a mesma regra do F1.1/ADR-0037
 * (`CNPJ` → `business_registered_address`/`organization`; demais →
 * `address_exists`/`person`). Uma Validation pode ter outras Claims; elas são
 * ignoradas na seleção, mas provocam inconsistência se houverem capturado o
 * recibo de documento do cliente.
 */
const ensureClaimForValidation = async (tx: DbTx, validation: ValidationForClaim): Promise<ClaimTarget> => {
  const spec = addressClaimForSubjectDocType(
    await loadSubjectDocType(tx, validation.tenantId, validation.subjectId),
  )

  let candidates = await loadAddressClaimCandidates(tx, validation, spec)
  if (candidates.length > 1) throw new HolderClaimInconsistencyError('multiple_address_claims')
  if (candidates.length === 0) {
    await tx
      .insert(t.claim)
      .values({
        claimId: randomUUID(),
        tenantId: validation.tenantId,
        validationId: validation.validationId,
        subjectId: validation.subjectId,
        addressId: validation.addressId,
        type: spec.type,
        subjectType: spec.subjectType,
        targetType: 'address',
      })
      .onConflictDoNothing()
    candidates = await loadAddressClaimCandidates(tx, validation, spec)
    if (candidates.length > 1) throw new HolderClaimInconsistencyError('multiple_address_claims')
  }

  const claimId = candidates[0]?.claimId
  if (claimId === undefined) throw new Error('claim insert failed')

  const linked = await loadValidationCustomerDocument(tx, validation.tenantId, validation.validationId)
  if (linked !== undefined) {
    if (linked.claimId !== claimId) {
      throw new HolderClaimInconsistencyError('linked_receipt_on_other_claim')
    }
    return { validation, claimId, existingReceiptId: linked.claimEvidenceId }
  }

  const receipts = await loadReceiptsForValidation(tx, validation.tenantId, validation.validationId)
  if (receipts.length === 0) return { validation, claimId, existingReceiptId: null }
  if (receipts.length > 1) throw new HolderClaimInconsistencyError('multiple_receipts_for_validation')

  const receipt = receipts[0]!
  if (receipt.claimId !== claimId) throw new HolderClaimInconsistencyError('receipt_on_other_claim')

  // Recibo criado antes da relação explícita (F1.1/F4.3 anteriores): adota o
  // vínculo sem recriar a evidência existente.
  await ensureValidationCustomerDocument(tx, {
    tenantId: validation.tenantId,
    validationId: validation.validationId,
    claimEvidenceId: receipt.claimEvidenceId,
  })
  return { validation, claimId, existingReceiptId: receipt.claimEvidenceId }
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
  // Relógio do tick. O lock da validation pode esperar: ele é relido com o
  // relógio injetável imediatamente depois de adquirido (ver abaixo), antes
  // de qualquer comparação de expiração.
  let now = (deps.now ?? (() => new Date()))()
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
        let linkedValidation: ValidationForClaim | undefined
        // Validation expirada não recebe novo artefato, recibo nem associação:
        // seu grafo está em remoção pela retenção (mesmo lock, mesma ordem).
        let validationExpired = false
        // A solicitação TINHA validation e ela desapareceu entre a leitura do
        // vínculo e a aquisição do lock (retenção/erasure concorrentes). Falha
        // fechada: nenhum artefato/análise/associação com retenção de 30 dias —
        // nunca se converte em "solicitação nunca vinculada".
        let validationRemoved = false
        const validationId = requestRow[0]?.validationId
        if (validationId !== null && validationId !== undefined) {
          linkedValidation = await loadValidationForClaim(tx, tenantId, validationId)
          // O lock pode esperar pela retenção: relê o relógio injetável logo
          // depois de adquiri-lo, antes de comparar `expires_at`.
          now = (deps.now ?? (() => new Date()))()
          if (linkedValidation === undefined) {
            // Releitura dentro da transação: comprova se a desvinculação foi
            // feita pela retenção/erasure (`validation_id` agora NULL) ou se o
            // ponteiro ficou pendente. Em ambos os casos NÃO há materialização.
            const [reread] = await tx
              .select({ validationId: t.holderInformationRequest.validationId })
              .from(t.holderInformationRequest)
              .where(
                and(
                  eq(t.holderInformationRequest.id, requestId),
                  eq(t.holderInformationRequest.tenantId, tenantId),
                ),
              )
              .limit(1)
            const unlinkedConcurrently = reread === undefined || reread.validationId === null
            validationRemoved = true
            deps.logger.error(
              {
                request_id: requestId,
                tenant_id: tenantId,
                validation_id: validationId,
                reason: unlinkedConcurrently
                  ? 'HOLDER_VALIDATION_REMOVED_CONCURRENTLY'
                  : 'HOLDER_VALIDATION_DANGLING_REFERENCE',
              },
              'holder request validation removed before lock; failing closed without materialization',
            )
          } else if (linkedValidation.expiresAt.getTime() <= now.getTime()) {
            // A retention só roda sobre validations expiradas e trava a mesma
            // linha antes de descobrir/excluir: nada criado aqui sobreviveria
            // ou escaparia dela.
            validationExpired = true
            deps.logger.warn(
              {
                request_id: requestId,
                tenant_id: tenantId,
                validation_id: validationId,
                reason: 'HOLDER_VALIDATION_EXPIRED',
              },
              'holder request validation expired; skipping artifact and claim materialization',
            )
          } else {
            try {
              claimTarget = await ensureClaimForValidation(tx, linkedValidation)
            } catch (error) {
              if (error instanceof HolderClaimInconsistencyError) {
                // Dado inconsistente não vira retry infinito. O documento
                // continua no domínio do Holder (artefato + análise), mas
                // nenhum recibo é criado/reutilizado em Claim de outra
                // finalidade.
                deps.logger.error(
                  {
                    request_id: requestId,
                    tenant_id: tenantId,
                    validation_id: validationId,
                    reason: 'HOLDER_CLAIM_INCONSISTENCY',
                    detail: error.reason,
                  },
                  'holder submission claim inconsistency; skipping claim materialization',
                )
              } else {
                throw error
              }
            }
          }
        }

        let failedCount = 0
        let primaryArtifact: {
          readonly document: StoredDocumentRow
          readonly artifact: MaterializedArtifact
        } | null = null

        for (const doc of validationExpired || validationRemoved ? [] : documents) {
          try {
            const artifact = await ensureArtifact(tx, {
              tenantId,
              requestId,
              document: doc,
              // Com Validation, o artefato acompanha o ciclo da evidência; sem
              // vínculo, mantém a política F4.3 de 30 dias.
              retentionUntil:
                linkedValidation?.expiresAt ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
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
          const target = claimTarget
          const primary = primaryArtifact
          try {
            // Savepoint: se o vínculo recibo ↔ Validation conflitar com uma
            // linha existente, o recibo recém-criado também é desfeito. Assim
            // não sobra recibo órfão nem se cria um segundo documento.
            await tx.transaction(async (savepoint) => {
              const receiptId =
                target.existingReceiptId ??
                (await ensureCustomerDocumentReceipt(savepoint, {
                  tenantId,
                  claimId: target.claimId,
                  validation: target.validation,
                  requestId,
                  documentId: primary.document.documentId,
                  artifact: primary.artifact,
                  now,
                }))

              await ensureValidationCustomerDocument(savepoint, {
                tenantId,
                validationId: target.validation.validationId,
                claimEvidenceId: receiptId,
              })

              await linkArtifactToReceipt(savepoint, {
                tenantId,
                artifactId: primary.artifact.artifactId,
                claimEvidenceId: receiptId,
              })
            })
          } catch (error) {
            if (error instanceof HolderClaimInconsistencyError) {
              deps.logger.error(
                {
                  request_id: requestId,
                  tenant_id: tenantId,
                  validation_id: target.validation.validationId,
                  reason: 'HOLDER_RECEIPT_INCONSISTENCY',
                  detail: error.reason,
                },
                'holder submission receipt inconsistency; skipping artifact link',
              )
            } else {
              throw error
            }
          }
        }

        // Remoção concorrente da validation: a submissão NÃO é sucesso — estado
        // terminal 'failed' com motivo, sem retry (a remoção não é transitória).
        const state = validationRemoved
          ? 'failed'
          : failedCount === documents.length
            ? 'failed'
            : failedCount > 0
              ? 'partial'
              : 'processed'
        const lastError = validationRemoved
          ? 'HOLDER_VALIDATION_REMOVED'
          : failedCount > 0
            ? `${failedCount} de ${documents.length} documento(s) falharam`
            : null

        await tx
          .insert(t.holderSubmissionProcessing)
          .values({
            processingId: randomUUID(),
            holderInformationRequestId: requestId,
            tenantId,
            state,
            attempts: 1,
            lastError,
            createdAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
            processedAt: sql`clock_timestamp()`,
          })
          .onConflictDoUpdate({
            target: [t.holderSubmissionProcessing.holderInformationRequestId],
            set: {
              state,
              attempts: sql`${t.holderSubmissionProcessing.attempts} + 1`,
              lastError,
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
