import {
  bigint,
  bigserial,
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { inet } from './custom-types.js'
import { tenant } from './tenancy.js'

/** Contador de uso por tenant (rate limit/quota e custo). */
export const usageEvent = pgTable(
  'usage_event',
  {
    eventId: uuid('event_id'),
    tenantId: uuid('tenant_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    eventType: text('event_type').notNull().default('technical_execution'),
    kind: text('kind').notNull(),
    units: integer('units').notNull().default(1),
    costMicros: bigint('cost_micros', { mode: 'number' }),
    validationId: uuid('validation_id'),
    idempotencyKey: text('idempotency_key'),
    billable: boolean('billable').notNull().default(false),
    source: text('source'),
  },
  (t) => [
    uniqueIndex('usage_event_idempotency_key_uq')
      .on(t.tenantId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  ],
)

/** Idempotência global de eventos de uso (tabela não particionada, ADR-0004). */
export const usageEventIdempotency = pgTable(
  'usage_event_idempotency',
  {
    tenantId: uuid('tenant_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    eventId: uuid('event_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.idempotencyKey] })],
)

/** Trilha de auditoria administrativa de alterações de cota. */
export const tenantQuotaAudit = pgTable('tenant_quota_audit', {
  auditId: bigserial('audit_id', { mode: 'number' }).primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.tenantId),
  previousQuota: bigint('previous_quota', { mode: 'number' }),
  newQuota: bigint('new_quota', { mode: 'number' }),
  changedBy: text('changed_by').notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  reason: text('reason'),
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
export type UsageEventIdempotency = typeof usageEventIdempotency.$inferSelect
export type NewUsageEventIdempotency = typeof usageEventIdempotency.$inferInsert
export type TenantQuotaAudit = typeof tenantQuotaAudit.$inferSelect
export type NewTenantQuotaAudit = typeof tenantQuotaAudit.$inferInsert
export type AuditLog = typeof auditLog.$inferSelect
export type NewAuditLog = typeof auditLog.$inferInsert
