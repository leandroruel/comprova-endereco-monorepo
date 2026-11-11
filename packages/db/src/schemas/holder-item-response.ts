import { sql } from 'drizzle-orm'
import { check, foreignKey, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { holderInformationRequest } from './holder-information-request.js'

/**
 * Resposta textual do Holder para um item da solicitação (F4.2).
 *
 * Um único valor por item, normalizado (`trim`) e limitado a 5000 caracteres.
 * Não há JSON arbitrário: a resposta é sempre texto plano.
 */
export const holderItemResponse = pgTable(
  'holder_item_response',
  {
    responseId: uuid('response_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    holderInformationRequestId: uuid('holder_information_request_id').notNull(),
    itemId: text('item_id').notNull(),
    value: text('value').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.holderInformationRequestId, t.tenantId],
      foreignColumns: [holderInformationRequest.id, holderInformationRequest.tenantId],
      name: 'holder_item_response_request_tenant_fk',
    }),
    unique('holder_item_response_request_item_unique').on(t.holderInformationRequestId, t.itemId),
    check('holder_item_response_value_length_check', sql`char_length(value) BETWEEN 1 AND 5000`),
    check('holder_item_response_value_trimmed_check', sql`value = btrim(value)`),
    index('idx_holder_item_response_tenant').on(t.tenantId),
    index('idx_holder_item_response_request').on(t.holderInformationRequestId),
  ],
)

export type HolderItemResponse = typeof holderItemResponse.$inferSelect
export type NewHolderItemResponse = typeof holderItemResponse.$inferInsert
