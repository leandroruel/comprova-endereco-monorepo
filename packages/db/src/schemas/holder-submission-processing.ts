import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  integer,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { holderInformationRequest } from './holder-information-request.js'
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- usado indiretamente em FK references
import { tenant } from './tenancy.js'

/**
 * F4.3 — ciclo de vida do processamento documental de uma submissão do Holder.
 *
 * Rastreia, por solicitação já submetida (`holder_information_request.state =
 * 'completed'`), se o Comprova processou os documentos e respostas enviados.
 *
 * A tabela NÃO altera `holder_information_request.state`: `completed`
 * significa apenas que o Holder terminou de fornecer informações. O
 * processamento documental é uma etapa distinta (F4.3 → F4.4).
 *
 * Estados:
 *   awaiting   — submetido, aguardando início do processamento
 *   processing — em processamento por um worker
 *   processed  — todos os documentos processados com sucesso
 *   partial    — pelo menos um documento processado, outros falharam
 *   failed     — nenhum documento pôde ser processado (erro definitivo)
 */
export const holderSubmissionProcessing = pgTable(
  'holder_submission_processing',
  {
    processingId: uuid('processing_id').primaryKey(),
    holderInformationRequestId: uuid('holder_information_request_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    state: text('state').notNull().default('awaiting'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.holderInformationRequestId, t.tenantId],
      foreignColumns: [holderInformationRequest.id, holderInformationRequest.tenantId],
      name: 'holder_submission_processing_request_tenant_fk',
    }),
    unique('holder_submission_processing_request_unique').on(t.holderInformationRequestId),
    check(
      'holder_submission_processing_state_check',
      sql`state IN ('awaiting', 'processing', 'processed', 'partial', 'failed')`,
    ),
    index('idx_holder_submission_processing_tenant').on(t.tenantId),
    index('idx_holder_submission_processing_state').on(t.tenantId, t.state),
    index('idx_holder_submission_processing_request').on(t.holderInformationRequestId),
  ],
)

export type HolderSubmissionProcessing = typeof holderSubmissionProcessing.$inferSelect
export type NewHolderSubmissionProcessing = typeof holderSubmissionProcessing.$inferInsert
