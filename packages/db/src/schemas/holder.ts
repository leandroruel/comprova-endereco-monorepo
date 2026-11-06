import { pgTable, text, timestamp, uuid, unique, index } from 'drizzle-orm/pg-core'
import { tenant } from './tenancy.js'

/**
 * Titular (Holder) de dados e documentos.
 *
 * Uma organização Verifier pode cadastrar titulares para processos de KYC.
 * Um mesmo titular pode existir em múltiplas organizações (cada organização
 * tem seu próprio registro), mas não existe uma identidade global de Holder
 * que permita correlacionar automaticamente titulares entre organizações.
 *
 * Dados pessoais sensíveis (CPF/CNPJ) não são armazenados em texto puro:
 * apenas o hash é persistido, aplicando minimização de dados.
 */
export const holder = pgTable(
  'holder',
  {
    holderId: uuid('holder_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    externalReference: text('external_reference').notNull(),
    name: text('name').notNull(),
    documentHash: text('document_hash').notNull(),
    documentType: text('document_type').notNull().default('CPF'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('holder_tenant_external_reference_unique').on(t.tenantId, t.externalReference),
    // Chave única composta para integridade referencial com kyc_process.
    unique('holder_id_tenant_unique').on(t.holderId, t.tenantId),
    index('holder_tenant_idx').on(t.tenantId),
    // Índice de document_hash isolado por tenant (privacidade e isolamento multi-tenant).
    index('holder_document_hash_idx').on(t.tenantId, t.documentHash),
  ],
)

export type Holder = typeof holder.$inferSelect
export type NewHolder = typeof holder.$inferInsert
