import { sql } from 'drizzle-orm'
import { bigint, check, foreignKey, index, pgTable, text, timestamp, uuid, unique } from 'drizzle-orm/pg-core'
import { bytea } from './custom-types.js'
import { holderInformationRequest } from './holder-information-request.js'

/**
 * Documento enviado pelo Holder (F4.2).
 *
 * `uploadState` separa a intenção (`pending`) do documento recebido
 * (`stored`). A linha `pending` é commitada antes do object storage, de modo
 * que não exista objeto sem registro rastreável. `deletedAt` é o tombstone
 * usado durante a remoção física.
 *
 * Documento recebido = `uploadState === 'stored' && deletedAt === null`.
 */
export const holderInformationRequestDocument = pgTable(
  'holder_information_request_document',
  {
    documentId: uuid('document_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    holderInformationRequestId: uuid('holder_information_request_id').notNull(),
    itemId: text('item_id').notNull(),
    uploadState: text('upload_state').notNull(),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    sha256: bytea('sha256'),
    originalFilename: text('original_filename'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.holderInformationRequestId, t.tenantId],
      foreignColumns: [holderInformationRequest.id, holderInformationRequest.tenantId],
    }),
    unique('holder_information_request_document_storage_key_unique').on(t.storageKey),
    check(
      'holder_information_request_document_state_check',
      sql`(upload_state = 'pending' AND content_type IS NULL AND size_bytes IS NULL AND sha256 IS NULL AND original_filename IS NULL)
        OR (upload_state = 'stored' AND content_type IS NOT NULL AND size_bytes IS NOT NULL AND sha256 IS NOT NULL AND original_filename IS NOT NULL)`,
    ),
    check(
      'holder_information_request_document_storage_key_check',
      sql`storage_key LIKE 'tenants/%/holder-requests/%'`,
    ),
    check(
      'holder_information_request_document_sha256_check',
      sql`sha256 IS NULL OR octet_length(sha256) = 32`,
    ),
    check('holder_information_request_document_size_check', sql`size_bytes IS NULL OR size_bytes > 0`),
    index('holder_information_request_document_tenant_idx').on(t.tenantId),
    index('holder_information_request_document_request_idx').on(t.tenantId, t.holderInformationRequestId),
    index('holder_information_request_document_item_idx').on(t.holderInformationRequestId, t.itemId),
  ],
)

export type HolderInformationRequestDocument = typeof holderInformationRequestDocument.$inferSelect
export type NewHolderInformationRequestDocument = typeof holderInformationRequestDocument.$inferInsert
