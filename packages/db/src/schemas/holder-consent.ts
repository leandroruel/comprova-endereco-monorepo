import { foreignKey, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { tenant } from './tenancy.js'
import { holderInformationRequest } from './holder-information-request.js'

/**
 * F4.1 — consentimento do Holder antes do envio de documentos.
 *
 * O Holder (sem conta) registra um aceite explícito dos termos aplicáveis
 * à solicitação. Não armazena texto jurídico nem dados pessoais: apenas a
 * versão dos termos apresentados, o estado, o timestamp do relógio do banco
 * e o vínculo com a solicitação. O texto dos termos é de responsabilidade do
 * produto (pendente de conteúdo aprovado).
 */
export const holderConsent = pgTable(
  'holder_consent',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    holderInformationRequestId: uuid('holder_information_request_id')
      .notNull()
      .references(() => holderInformationRequest.id),
    termsVersion: text('terms_version').notNull(),
    termsHash: text('terms_hash'),
    state: text('state').notNull().default('granted').$type<'granted' | 'withdrawn'>(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Integridade referencial composta: o consentimento pertence ao mesmo tenant da solicitação.
    foreignKey({
      columns: [t.holderInformationRequestId, t.tenantId],
      foreignColumns: [holderInformationRequest.id, holderInformationRequest.tenantId],
    }),
    // Um consentimento por solicitação (idempotência de aceite).
    unique('holder_consent_request_unique').on(t.holderInformationRequestId),
  ],
)

export type HolderConsent = typeof holderConsent.$inferSelect
export type NewHolderConsent = typeof holderConsent.$inferInsert
