import { pgTable, text, timestamp, uuid, index } from 'drizzle-orm/pg-core'
import { tenant } from './tenancy.js'
import { holder } from './holder.js'

/**
 * Processo de KYC associado a um titular.
 *
 * O estado do KYC é independente das obrigações documentais. As transições
 * de estado são explícitas e validadas no backend: um processo só pode avançar
 * por transições definidas no modelo de domínio (pending → in_progress →
 * approved/rejected/expired).
 */
export const kycProcess = pgTable(
  'kyc_process',
  {
    kycProcessId: uuid('kyc_process_id').primaryKey(),
    holderId: uuid('holder_id')
      .notNull()
      .references(() => holder.holderId),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    state: text('state').notNull().default('pending'),
    legalBasis: text('legal_basis').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    index('kyc_process_holder_idx').on(t.holderId),
    index('kyc_process_tenant_idx').on(t.tenantId),
    index('kyc_process_state_idx').on(t.state),
  ],
)

export type KycProcess = typeof kycProcess.$inferSelect
export type NewKycProcess = typeof kycProcess.$inferInsert

/**
 * Evento de auditoria para um processo KYC.
 *
 * Cada transição de estado e operação relevante gera um evento imutável,
 * permitindo auditoria completa de quem alterou o estado, quando e por quê.
 */
export const kycEvent = pgTable(
  'kyc_event',
  {
    kycEventId: uuid('kyc_event_id').primaryKey(),
    kycProcessId: uuid('kyc_process_id')
      .notNull()
      .references(() => kycProcess.kycProcessId),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    eventType: text('event_type').notNull(),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    actor: text('actor').notNull(),
    details: text('details').notNull().default('{}'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('kyc_event_process_idx').on(t.kycProcessId),
    index('kyc_event_tenant_idx').on(t.tenantId),
    index('kyc_event_created_at_idx').on(t.createdAt),
  ],
)

export type KycEvent = typeof kycEvent.$inferSelect
export type NewKycEvent = typeof kycEvent.$inferInsert
