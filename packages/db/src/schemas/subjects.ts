import { pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { bytea } from './custom-types.js'
import { docTypeEnum } from './enums.js'
import { tenant } from './tenancy.js'

/**
 * Sujeito de uma validation, escopado por tenant. O documento nunca é persistido
 * em claro: `doc_hmac` indexa e `doc_enc` (quando presente) cifra.
 */
export const subject = pgTable(
  'subject',
  {
    subjectId: uuid('subject_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    docType: docTypeEnum('doc_type').notNull(),
    docHmac: bytea('doc_hmac').notNull(),
    docEnc: bytea('doc_enc'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('subject_tenant_hmac_uq').on(t.tenantId, t.docType, t.docHmac),
    // Chave única de apoio para a FK composta de `claim` (MÉDIO-5):
    // garante que claim.tenant_id = subject.tenant_id.
    unique('subject_subject_id_tenant_id_key').on(t.subjectId, t.tenantId),
  ],
)

export type Subject = typeof subject.$inferSelect
export type NewSubject = typeof subject.$inferInsert
