import { sql } from 'drizzle-orm'
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { holder } from './holder.js'
import { tenant } from './tenancy.js'

/**
 * Solicitação de informações enviada por um Verifier a um Holder.
 *
 * Representa o primeiro passo do ciclo F4: Verifier solicita → Holder fornece
 * → Comprova processa → Verifier recebe resultado.
 *
 * Nesta entrega somente a criação, consulta, listagem e cancelamento são
 * implementados. O envio de informações/documentos pelo Holder fica para F4.2.
 *
 * Não armazena documentos ou evidências diretamente nesta entidade.
 */
export const holderInformationRequest = pgTable(
  'holder_information_request',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    holderId: uuid('holder_id').notNull(),
    type: text('type').notNull(),
    purpose: text('purpose').notNull(),
    items: jsonb('items')
      .$type<
        {
          itemId: string
          description: string
          required: boolean
          documentType?: string
        }[]
      >()
      .notNull(),
    state: text('state').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
  },
  (t) => [
    // Integridade referencial composta: holder pertence ao mesmo tenant.
    foreignKey({
      columns: [t.holderId, t.tenantId],
      foreignColumns: [holder.holderId, holder.tenantId],
    }),
    check(
      'holder_information_request_state_check',
      sql`state IN ('pending', 'in_progress', 'completed', 'cancelled', 'expired')`,
    ),
    // Chave única composta para integridade referencial com holder_information_request_event.
    unique('holder_information_request_id_tenant_unique').on(t.id, t.tenantId),
    index('holder_information_request_tenant_idx').on(t.tenantId),
    index('holder_information_request_holder_idx').on(t.holderId),
    index('holder_information_request_state_idx').on(t.state),
    index('holder_information_request_expires_at_idx').on(t.expiresAt),
    index('holder_information_request_tenant_state_idx').on(t.tenantId, t.state),
    index('holder_information_request_tenant_holder_idx').on(t.tenantId, t.holderId),
  ],
)

export type HolderInformationRequest = typeof holderInformationRequest.$inferSelect
export type NewHolderInformationRequest = typeof holderInformationRequest.$inferInsert
