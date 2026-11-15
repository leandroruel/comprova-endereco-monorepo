import { foreignKey, index, pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { claimEvidence } from './claims.js'
import { tenant } from './tenancy.js'

/**
 * F4.3 → F1.1/F1.3 — recibo `customer_submitted_document` por Validation.
 *
 * `claim_evidence` garante no máximo um documento por Claim
 * (`idx_claim_evidence_customer_document_uq`). Como uma Validation pode ter
 * mais de uma Claim, essa unicidade sozinha não impede dois recibos na mesma
 * Validation. Esta tabela materializa a relação 1:1:
 *
 *   - `validation_id` é PK → no máximo um recibo por Validation;
 *   - `UNIQUE (claim_evidence_id)` → um recibo pertence a no máximo uma
 *     Validation.
 *
 * Não há FK para `validation`: a PK é composta
 * `(validation_id, created_at)` e a tabela é particionada por `created_at`.
 * A aplicação valida existência/tenant sob o lock da linha da Validation.
 * A FK composta com `claim_evidence` garante o mesmo tenant do recibo.
 */
export const validationCustomerDocument = pgTable(
  'validation_customer_document',
  {
    validationId: uuid('validation_id').primaryKey(),
    claimEvidenceId: uuid('claim_evidence_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.claimEvidenceId, t.tenantId],
      foreignColumns: [claimEvidence.claimEvidenceId, claimEvidence.tenantId],
      name: 'validation_customer_document_claim_evidence_tenant_fk',
    }).onDelete('cascade'),
    unique('validation_customer_document_claim_evidence_uq').on(t.claimEvidenceId),
    index('validation_customer_document_tenant_idx').on(t.tenantId),
  ],
)

export type ValidationCustomerDocument = typeof validationCustomerDocument.$inferSelect
export type NewValidationCustomerDocument = typeof validationCustomerDocument.$inferInsert
