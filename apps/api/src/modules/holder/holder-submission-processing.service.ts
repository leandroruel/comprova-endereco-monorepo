import {
  and,
  eq,
  isNull,
  insertPendingEvidenceAnalysis,
  sql,
  withTenant,
  type Db,
  type DbTx,
  type PendingEvidenceAnalysisInput,
} from '@comprova/db'
import * as t from '@comprova/db'
import { randomUUID } from 'node:crypto'
import type { Logger } from '@comprova/observability'
import type { ObjectStore } from '@comprova/providers'

const errorNameOf = (error: unknown): string => (error instanceof Error ? error.name : 'unknown')

export interface HolderSubmissionProcessingDeps {
  readonly db: Db
  readonly store: ObjectStore
  readonly logger: Logger
}

interface ProcessingRow {
  readonly processingId: string
  readonly holderInformationRequestId: string
  readonly tenantId: string
  readonly state: string
  readonly attempts: number
  readonly lastError: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly processedAt: Date | null
}

interface DocumentToProcess {
  readonly documentId: string
  readonly storageKey: string
  readonly itemId: string
  /** Metadados reais do objeto já gravado pelo intake do Holder (F4.2). */
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: Buffer
  /** Data/hora em que o documento foi recebido (upload concluído). */
  readonly createdAt: Date
}

type ProcessingState = 'awaiting' | 'processing' | 'processed' | 'partial' | 'failed'

/**
 * F4.3 — serviço de processamento de submissões do Holder.
 *
 * Rastreia o ciclo de vida do processamento documental de uma solicitação já
 * submetida pelo Holder (estado `completed`). Não cria uma segunda pipeline
 * documental: reutiliza `evidence_artifact` + `evidence_analysis` (F1.2)
 * existentes, vinculando o artefato diretamente à solicitação via
 * `holder_information_request_id`.
 *
 * Garantias:
 *   - Uma linha por `holder_information_request_id` (único).
 *   - Transição de estado serializada por `FOR UPDATE` na linha de
 *     processamento.
 *   - Idempotência: reprocessar uma submissão já concluída não duplica
 *     artefatos nem análises.
 *   - Falha em um documento não apaga resultados de outros documentos.
 *   - Não grava PII (token, CPF, endereço, conteúdo) nem logs de documento.
 */
export const makeHolderSubmissionProcessingService = (deps: HolderSubmissionProcessingDeps) => {
  const { db, logger } = deps

  const logError = (operation: string, tenantId: string, error: unknown): void => {
    logger.error(
      {
        tenant_id: tenantId,
        operation,
        error_name: errorNameOf(error),
      },
      'holder submission processing failed',
    )
  }

  const getProcessing = async (
    holderInformationRequestId: string,
    tenantId: string,
  ): Promise<ProcessingRow | null> => {
    const [row] = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select({
          processingId: t.holderSubmissionProcessing.processingId,
          holderInformationRequestId: t.holderSubmissionProcessing.holderInformationRequestId,
          tenantId: t.holderSubmissionProcessing.tenantId,
          state: t.holderSubmissionProcessing.state,
          attempts: t.holderSubmissionProcessing.attempts,
          lastError: t.holderSubmissionProcessing.lastError,
          createdAt: t.holderSubmissionProcessing.createdAt,
          updatedAt: t.holderSubmissionProcessing.updatedAt,
          processedAt: t.holderSubmissionProcessing.processedAt,
        })
        .from(t.holderSubmissionProcessing)
        .where(
          and(
            eq(t.holderSubmissionProcessing.holderInformationRequestId, holderInformationRequestId),
            eq(t.holderSubmissionProcessing.tenantId, tenantId),
          ),
        )
        .limit(1)
    })
    return row ?? null
  }

  /**
   * Cria (ou reativa) o registro de processamento para uma submissão
   * concluída. Chamado pelo worker após consumir o evento de outbox.
   * Retorna `null` se já existe um registro em estado terminal.
   */
  const ensureProcessing = async (
    holderInformationRequestId: string,
    tenantId: string,
  ): Promise<ProcessingRow | null> => {
    return withTenant(db, tenantId, async (tx) => {
      const existing = await tx
        .select({
          processingId: t.holderSubmissionProcessing.processingId,
          holderInformationRequestId: t.holderSubmissionProcessing.holderInformationRequestId,
          tenantId: t.holderSubmissionProcessing.tenantId,
          state: t.holderSubmissionProcessing.state,
          attempts: t.holderSubmissionProcessing.attempts,
          lastError: t.holderSubmissionProcessing.lastError,
          createdAt: t.holderSubmissionProcessing.createdAt,
          updatedAt: t.holderSubmissionProcessing.updatedAt,
          processedAt: t.holderSubmissionProcessing.processedAt,
        })
        .from(t.holderSubmissionProcessing)
        .where(
          and(
            eq(t.holderSubmissionProcessing.holderInformationRequestId, holderInformationRequestId),
            eq(t.holderSubmissionProcessing.tenantId, tenantId),
          ),
        )
        .for('update')
        .limit(1)

      const row = existing[0]
      if (row) {
        const state = row.state as ProcessingState
        if (state === 'processed' || state === 'failed') {
          // Já processado definitivamente: não reativa.
          return row
        }
        // awaiting/processing: mantém o registro existente.
        return row
      }

      // Não existe registro ainda: cria em `awaiting`.
      const [inserted] = await tx
        .insert(t.holderSubmissionProcessing)
        .values({
          processingId: randomUUID(),
          holderInformationRequestId,
          tenantId,
          state: 'awaiting',
          attempts: 0,
          lastError: null,
          createdAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
          processedAt: null,
        })
        .returning({
          processingId: t.holderSubmissionProcessing.processingId,
          holderInformationRequestId: t.holderSubmissionProcessing.holderInformationRequestId,
          tenantId: t.holderSubmissionProcessing.tenantId,
          state: t.holderSubmissionProcessing.state,
          attempts: t.holderSubmissionProcessing.attempts,
          lastError: t.holderSubmissionProcessing.lastError,
          createdAt: t.holderSubmissionProcessing.createdAt,
          updatedAt: t.holderSubmissionProcessing.updatedAt,
          processedAt: t.holderSubmissionProcessing.processedAt,
        })

      if (!inserted) return null
      return inserted
    })
  }

  /**
   * Reivindica o registro de processamento para execução por um worker.
   * Usa `FOR UPDATE` para serializar concorrentes. Apenas estados
   * `awaiting` ou `processing` expirados podem ser reivindicados.
   */
  const claimProcessing = async (
    holderInformationRequestId: string,
    tenantId: string,
    staleMs: number,
  ): Promise<ProcessingRow | null> => {
    const now = new Date()
    const staleBefore = new Date(now.getTime() - staleMs)
    return withTenant(db, tenantId, async (tx) => {
      const [row] = await tx
        .select({
          processingId: t.holderSubmissionProcessing.processingId,
          holderInformationRequestId: t.holderSubmissionProcessing.holderInformationRequestId,
          tenantId: t.holderSubmissionProcessing.tenantId,
          state: t.holderSubmissionProcessing.state,
          attempts: t.holderSubmissionProcessing.attempts,
          lastError: t.holderSubmissionProcessing.lastError,
          createdAt: t.holderSubmissionProcessing.createdAt,
          updatedAt: t.holderSubmissionProcessing.updatedAt,
          processedAt: t.holderSubmissionProcessing.processedAt,
        })
        .from(t.holderSubmissionProcessing)
        .where(
          and(
            eq(t.holderSubmissionProcessing.holderInformationRequestId, holderInformationRequestId),
            eq(t.holderSubmissionProcessing.tenantId, tenantId),
            sql`(
              ${t.holderSubmissionProcessing.state} = 'awaiting'
              OR (
                ${t.holderSubmissionProcessing.state} = 'processing'
                AND ${t.holderSubmissionProcessing.updatedAt} < ${staleBefore.toISOString()}
              )
            )`,
          ),
        )
        .for('update')
        .limit(1)

      if (!row) return null

      const updated = await tx
        .update(t.holderSubmissionProcessing)
        .set({
          state: 'processing',
          attempts: row.attempts + 1,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(t.holderSubmissionProcessing.processingId, row.processingId),
            eq(t.holderSubmissionProcessing.tenantId, tenantId),
          ),
        )
        .returning({
          processingId: t.holderSubmissionProcessing.processingId,
          holderInformationRequestId: t.holderSubmissionProcessing.holderInformationRequestId,
          tenantId: t.holderSubmissionProcessing.tenantId,
          state: t.holderSubmissionProcessing.state,
          attempts: t.holderSubmissionProcessing.attempts,
          lastError: t.holderSubmissionProcessing.lastError,
          createdAt: t.holderSubmissionProcessing.createdAt,
          updatedAt: t.holderSubmissionProcessing.updatedAt,
          processedAt: t.holderSubmissionProcessing.processedAt,
        })

      return updated[0] ?? null
    })
  }

  /**
   * Lista os documentos ativos (stored, sem tombstone) da solicitação.
   */
  const listActiveDocuments = async (
    tx: DbTx,
    tenantId: string,
    holderInformationRequestId: string,
  ): Promise<DocumentToProcess[]> => {
    const rows = await tx
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
          eq(t.holderInformationRequestDocument.holderInformationRequestId, holderInformationRequestId),
          eq(t.holderInformationRequestDocument.tenantId, tenantId),
          eq(t.holderInformationRequestDocument.uploadState, 'stored'),
          isNull(t.holderInformationRequestDocument.deletedAt),
        ),
      )
    // `upload_state = 'stored'` garante (check constraint) os metadados abaixo;
    // o filtro explícito evita que um registro inconsistente vire artefato.
    return rows.flatMap((r) =>
      r.contentType === null || r.sizeBytes === null || r.sha256 === null
        ? []
        : [
            {
              documentId: r.documentId,
              storageKey: r.storageKey,
              itemId: r.itemId,
              contentType: r.contentType,
              sizeBytes: r.sizeBytes,
              sha256: r.sha256,
              createdAt: r.createdAt,
            },
          ],
    )
  }

  /**
   * Processa todos os documentos ativos de uma submissão:
   * - Cria evidence_artifact vinculado diretamente à solicitação
   *   (holder_information_request_id) se ainda não existir para este
   *   storage_key.
   * - Insere evidence_analysis (status='pending', idempotente por
   *   ON CONFLICT DO NOTHING).
   * Retorna { processados, falhados, erros }.
   */
  const processDocuments = async (
    tx: DbTx,
    tenantId: string,
    holderInformationRequestId: string,
    documents: DocumentToProcess[],
  ): Promise<{
    readonly processed: number
    readonly failed: number
    readonly errors: string[]
  }> => {
    let processed = 0
    let failed = 0
    const errors: string[] = []

    // O artefato acompanha o ciclo da Validation quando a solicitação está
    // vinculada; sem vínculo, mantém a política F4.3 de 30 dias.
    const [requestRow] = await tx
      .select({ validationId: t.holderInformationRequest.validationId })
      .from(t.holderInformationRequest)
      .where(
        and(
          eq(t.holderInformationRequest.id, holderInformationRequestId),
          eq(t.holderInformationRequest.tenantId, tenantId),
        ),
      )
      .limit(1)
    const validationId = requestRow?.validationId
    // Protocolo de lock: quando a solicitação está vinculada, a linha da
    // validation é travada com FOR UPDATE (mesma ordem do intake F1.1 e do
    // worker F4.3) antes de criar qualquer artefato para o grafo dela.
    const [validationRow] =
      validationId === null || validationId === undefined
        ? []
        : await tx
            .select({ expiresAt: t.validation.expiresAt })
            .from(t.validation)
            .where(and(eq(t.validation.validationId, validationId), eq(t.validation.tenantId, tenantId)))
            .for('update')
            .limit(1)

    // A solicitação tinha validation e ela desapareceu entre a leitura do
    // vínculo e o lock (retenção/erasure concorrentes). Falha fechada: nunca
    // vira "nunca vinculada" nem cria artefato com retenção de 30 dias.
    if (validationId !== null && validationId !== undefined && validationRow === undefined) {
      return {
        processed: 0,
        failed: documents.length,
        errors: documents.map((doc) => `${doc.documentId}: VALIDATION_REMOVED`),
      }
    }

    // Validation expirada não recebe novo artefato: seu grafo está em remoção
    // pela retenção (que adquire o mesmo lock antes de descobrir/excluir). A
    // comparação acontece depois da aquisição do lock.
    if (validationRow !== undefined && validationRow.expiresAt.getTime() <= new Date().getTime()) {
      return {
        processed: 0,
        failed: documents.length,
        errors: documents.map((doc) => `${doc.documentId}: VALIDATION_EXPIRED`),
      }
    }

    const retentionUntil = validationRow?.expiresAt ?? new Date(Date.now() + 30 * 86_400_000)

    for (const doc of documents) {
      try {
        // Verifica se já existe um artefato para este documento nesta solicitação.
        const [existingArtifact] = await tx
          .select({ artifactId: t.evidenceArtifact.artifactId })
          .from(t.evidenceArtifact)
          .where(
            and(
              eq(t.evidenceArtifact.holderInformationRequestId, holderInformationRequestId),
              eq(t.evidenceArtifact.tenantId, tenantId),
              eq(t.evidenceArtifact.storageKey, doc.storageKey),
            ),
          )
          .limit(1)

        let artifactId: string
        if (existingArtifact) {
          artifactId = existingArtifact.artifactId
        } else {
          // Cria o artefato vinculado diretamente à solicitação do Holder.
          // claim_evidenceId é NULL: usa holder_information_request_id.
          // Os metadados vêm do documento já gravado (F4.2) — nunca de
          // placeholders — e o objeto é o MESMO (`storage_key` do intake).
          artifactId = randomUUID()
          await tx.insert(t.evidenceArtifact).values({
            artifactId,
            tenantId,
            claimEvidenceId: null,
            holderInformationRequestId,
            storageKey: doc.storageKey,
            contentType: doc.contentType,
            sizeBytes: doc.sizeBytes,
            sha256: doc.sha256,
            documentIssuedAt: null, // não fornecido pelo Holder no upload
            receivedAt: doc.createdAt ?? new Date(), // quando o documento foi armazenado pelo Holder
            retentionUntil,
          })
        }

        // Insere análise pendente (idempotente por artifact+analyzer+version+contract).
        const analysisInput: PendingEvidenceAnalysisInput = {
          tenantId,
          artifactId,
        }
        await insertPendingEvidenceAnalysis(tx, analysisInput)

        processed += 1
      } catch (error) {
        failed += 1
        errors.push(`${doc.documentId}: ${errorNameOf(error)}`)
      }
    }

    return { processed, failed, errors }
  }

  /**
   * Atualiza o estado final do processamento.
   */
  const finalizeProcessing = async (
    processingId: string,
    tenantId: string,
    state: ProcessingState,
    lastError: string | null,
  ): Promise<void> => {
    await withTenant(db, tenantId, async (tx) => {
      await tx
        .update(t.holderSubmissionProcessing)
        .set({
          state,
          lastError,
          updatedAt: sql`clock_timestamp()`,
          processedAt: state === 'processed' || state === 'failed' ? sql`clock_timestamp()` : null,
        })
        .where(
          and(
            eq(t.holderSubmissionProcessing.processingId, processingId),
            eq(t.holderSubmissionProcessing.tenantId, tenantId),
          ),
        )
    })
  }

  return {
    getProcessing,
    ensureProcessing,
    claimProcessing,
    listActiveDocuments,
    processDocuments,
    finalizeProcessing,
    logError,
  }
}
