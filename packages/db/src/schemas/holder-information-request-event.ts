import { foreignKey, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { holderInformationRequest } from './holder-information-request.js'

/**
 * Evento de auditoria imutável para uma solicitação de informações ao Holder.
 *
 * Cada criação, cancelamento e expiração gera um evento, permitindo rastrear
 * quem alterou o estado, quando e por quê.
 *
 * Segue o mesmo padrão de kyc_event: apenas SELECT e INSERT são permitidos.
 */
export const holderInformationRequestEvent = pgTable(
  'holder_information_request_event',
  {
    id: uuid('id').primaryKey(),
    holderInformationRequestId: uuid('holder_information_request_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    eventType: text('event_type').notNull(),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    actor: text('actor').notNull(),
    details: text('details').notNull().default('{}'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Integridade referencial composta: evento pertence ao mesmo tenant da solicitação.
    foreignKey({
      columns: [t.holderInformationRequestId, t.tenantId],
      foreignColumns: [holderInformationRequest.id, holderInformationRequest.tenantId],
    }),
    index('holder_information_request_event_request_idx').on(t.holderInformationRequestId),
    index('holder_information_request_event_tenant_idx').on(t.tenantId),
    index('holder_information_request_event_created_at_idx').on(t.createdAt),
  ],
)

export type HolderInformationRequestEvent = typeof holderInformationRequestEvent.$inferSelect
export type NewHolderInformationRequestEvent = typeof holderInformationRequestEvent.$inferInsert
