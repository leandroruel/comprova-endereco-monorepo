import { pgTable, text, timestamp, uuid, foreignKey, index, unique } from 'drizzle-orm/pg-core'
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
    holderId: uuid('holder_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    state: text('state').notNull().default('pending'),
    legalBasis: text('legal_basis').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    // Integridade referencial composta: holder pertence ao mesmo tenant.
    foreignKey({
      columns: [t.holderId, t.tenantId],
      foreignColumns: [holder.holderId, holder.tenantId],
    }),
    // Chave única composta para integridade referencial com kyc_event.
    unique('kyc_process_id_tenant_unique').on(t.kycProcessId, t.tenantId),
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
    kycProcessId: uuid('kyc_process_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    eventType: text('event_type').notNull(),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    actor: text('actor').notNull(),
    details: text('details').notNull().default('{}'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Integridade referencial composta: evento pertence ao mesmo tenant do processo.
    foreignKey({
      columns: [t.kycProcessId, t.tenantId],
      foreignColumns: [kycProcess.kycProcessId, kycProcess.tenantId],
    }),
    index('kyc_event_process_idx').on(t.kycProcessId),
    index('kyc_event_tenant_idx').on(t.tenantId),
    index('kyc_event_created_at_idx').on(t.createdAt),
  ],
)

export type KycEvent = typeof kycEvent.$inferSelect
export type NewKycEvent = typeof kycEvent.$inferInsert
