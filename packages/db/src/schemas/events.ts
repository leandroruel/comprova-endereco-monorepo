import { bigserial, boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { bytea } from './custom-types.js'
import { tenant } from './tenancy.js'

/** Outbox transacional: evento gravado na mesma transação do fato de negócio. */
export const outbox = pgTable('outbox', {
  outboxId: bigserial('outbox_id', { mode: 'number' }).primaryKey(),
  aggregate: text('aggregate').notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
})

export const webhookEndpoint = pgTable('webhook_endpoint', {
  endpointId: uuid('endpoint_id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.tenantId),
  url: text('url').notNull(),
  secretEnc: bytea('secret_enc').notNull(),
  events: text('events').array().notNull(),
  active: boolean('active').notNull().default(true),
})

export const webhookDelivery = pgTable('webhook_delivery', {
  deliveryId: uuid('delivery_id').primaryKey(),
  endpointId: uuid('endpoint_id')
    .notNull()
    .references(() => webhookEndpoint.endpointId),
  validationId: uuid('validation_id').notNull(),
  attempt: integer('attempt').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  status: text('status').notNull(),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  eventType: text('event_type').notNull().default(''),
})

export type Outbox = typeof outbox.$inferSelect
export type NewOutbox = typeof outbox.$inferInsert
export type WebhookEndpoint = typeof webhookEndpoint.$inferSelect
export type NewWebhookEndpoint = typeof webhookEndpoint.$inferInsert
export type WebhookDelivery = typeof webhookDelivery.$inferSelect
export type NewWebhookDelivery = typeof webhookDelivery.$inferInsert
