import { bigint, bigserial, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { inet } from './custom-types.js'

/** Contador de uso por tenant (rate limit/quota e custo). */
export const usageEvent = pgTable('usage_event', {
  tenantId: uuid('tenant_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  kind: text('kind').notNull(),
  units: integer('units').notNull().default(1),
  costMicros: bigint('cost_micros', { mode: 'number' }),
  validationId: uuid('validation_id'),
})

/** Trilha de auditoria administrativa. */
export const auditLog = pgTable('audit_log', {
  auditId: bigserial('audit_id', { mode: 'number' }).primaryKey(),
  tenantId: uuid('tenant_id'),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  ip: inet('ip'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
})

export type UsageEvent = typeof usageEvent.$inferSelect
export type NewUsageEvent = typeof usageEvent.$inferInsert
export type AuditLog = typeof auditLog.$inferSelect
export type NewAuditLog = typeof auditLog.$inferInsert
