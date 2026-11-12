import { and, eq, isNull, sql, withTenant } from '@comprova/db'
import type { Db } from '@comprova/db'
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

/**
 * F4.3 — loop de processamento de submissões do Holder.
 *
 * Consome eventos de outbox `holder_submission.processing_requested` e executa
 * o processamento documental (criação de evidence_artifact + evidence_analysis)
 * para cada submissão concluída pelo Holder.
 *
 * Segue o mesmo padrão de `analyzeEvidenceTick`:
 *   - Lê eventos não publicados do outbox com FOR UPDATE SKIP LOCKED
 *   - Marca como publicados após o processamento
 *   - Cada submissão é processada com seu próprio tenant via withTenant
 *   - Idempotente: reprocessar não duplica artefatos nem análises
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

        // Lista documentos ativos da solicitação.
        const documents = await tx
          .select({
            documentId: t.holderInformationRequestDocument.documentId,
            storageKey: t.holderInformationRequestDocument.storageKey,
            itemId: t.holderInformationRequestDocument.itemId,
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

        let failedCount = 0
        for (const doc of documents) {
          try {
            const [existingArtifact] = await tx
              .select({ artifactId: t.evidenceArtifact.artifactId })
              .from(t.evidenceArtifact)
              .where(
                and(
                  eq(t.evidenceArtifact.holderInformationRequestId, requestId),
                  eq(t.evidenceArtifact.tenantId, tenantId),
                  eq(t.evidenceArtifact.storageKey, doc.storageKey),
                ),
              )
              .limit(1)

            let artifactId: string
            if (existingArtifact) {
              artifactId = existingArtifact.artifactId
            } else {
              artifactId = randomUUID()
              await tx.insert(t.evidenceArtifact).values({
                artifactId,
                tenantId,
                claimEvidenceId: null,
                holderInformationRequestId: requestId,
                storageKey: doc.storageKey,
                contentType: 'application/pdf',
                sizeBytes: 0,
                sha256: Buffer.from(new Uint8Array(32)),
                retentionUntil: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
              })
            }

            // Insere análise pendente (idempotente).
            await tx.execute(sql`
              INSERT INTO evidence_analysis (
                analysis_id, tenant_id, artifact_id, analyzer, analyzer_version,
                contract_version, status, attempts, created_at, updated_at
              )
              VALUES (
                gen_random_uuid(), ${tenantId}, ${artifactId},
                'text_document', '1.3.0', '4',
                'pending', 0, clock_timestamp(), clock_timestamp()
              )
              ON CONFLICT (artifact_id, analyzer, analyzer_version, contract_version) DO NOTHING
            `)
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
