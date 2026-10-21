import { integer, pgTable, real, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { docTypeEnum, valModeEnum } from './enums.js'
import { legalBasis } from './reference-receita.js'
import { tenant } from './tenancy.js'

export const batch = pgTable('batch', {
  batchId: uuid('batch_id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.tenantId),
  userId: text('user_id'),
  status: text('status').notNull().default('queued'),
  totalItems: integer('total_items').notNull(),
  mode: valModeEnum('mode').notNull(),
  legalBasis: text('legal_basis')
    .notNull()
    .references(() => legalBasis.code),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
})

export const batchItem = pgTable(
  'batch_item',
  {
    itemId: uuid('item_id').primaryKey(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => batch.batchId),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    position: integer('position').notNull(),
    docType: docTypeEnum('doc_type').notNull(),
    docDigits: text('doc_digits').notNull(),
    status: text('status').notNull().default('pending'),
    validationId: uuid('validation_id'),
    errorCode: text('error_code'),
    verdict: text('verdict'),
    confidence: real('confidence'),
    explanation: text('explanation'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [unique('batch_item_position_uq').on(t.batchId, t.position)],
)

export type Batch = typeof batch.$inferSelect
export type NewBatch = typeof batch.$inferInsert
export type BatchItem = typeof batchItem.$inferSelect
export type NewBatchItem = typeof batchItem.$inferInsert
