import { foreignKey, index, pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { claimEvidence } from './claims.js'
import { evidenceArtifact } from './evidence-artifact.js'
import { tenant } from './tenancy.js'

/**
 * F4.3 → F1.2/F1.3 — vínculo explícito entre um artefato do Holder e o recibo
 * de intake da Claim.
 *
 * `evidence_artifact` continua com a regra de fonte exclusiva (ADR-0035): o
 * artefato enviado pelo Holder pertence à `holder_information_request` e tem
 * `claim_evidence_id = NULL`. Esta tabela de associação adiciona a participação
 * desse mesmo artefato no pipeline da Claim sem reescrever o artefato
 * (write-once) nem duplicar bytes.
 *
 * Cardinalidade 1:1:
 *   - PK em `artifact_id` → um artefato participa de no máximo um recibo;
 *   - UNIQUE em `claim_evidence_id` → um recibo tem no máximo um artefato.
 *
 * A FK composta com `tenant_id` garante que artefato e recibo pertencem ao
 * mesmo tenant. Sem UPDATE: o vínculo é imutável; a remoção do artefato ou do
 * recibo (retenção/erasure) apaga o vínculo por cascata.
 */
export const evidenceArtifactClaimEvidence = pgTable(
  'evidence_artifact_claim_evidence',
  {
    artifactId: uuid('artifact_id').primaryKey(),
    claimEvidenceId: uuid('claim_evidence_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.artifactId, t.tenantId],
      foreignColumns: [evidenceArtifact.artifactId, evidenceArtifact.tenantId],
      name: 'evidence_artifact_claim_evidence_artifact_tenant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.claimEvidenceId, t.tenantId],
      foreignColumns: [claimEvidence.claimEvidenceId, claimEvidence.tenantId],
      name: 'evidence_artifact_claim_evidence_claim_evidence_tenant_fk',
    }).onDelete('cascade'),
    unique('evidence_artifact_claim_evidence_claim_evidence_uq').on(t.claimEvidenceId),
    index('evidence_artifact_claim_evidence_tenant_claim_idx').on(t.tenantId, t.claimEvidenceId),
  ],
)

export type EvidenceArtifactClaimEvidence = typeof evidenceArtifactClaimEvidence.$inferSelect
export type NewEvidenceArtifactClaimEvidence = typeof evidenceArtifactClaimEvidence.$inferInsert
