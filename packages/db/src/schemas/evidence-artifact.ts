import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { claimEvidence } from './claims.js'
import { bytea } from './custom-types.js'
import { tenant } from './tenancy.js'

/**
 * Limite de tamanho do artefato bruto (50 MiB). É uma defesa de entrada, não
 * uma regra de negócio: PDFs/imagens de comprovante ficam muito abaixo disso.
 */
export const EVIDENCE_ARTIFACT_MAX_BYTES = 52_428_800

/**
 * Artefato FÍSICO de evidência, tenant-scoped.
 *
 * Separação (ADR-0035):
 *   - `evidence_artifact` = bytes/objeto bruto em object storage (PII de cliente);
 *   - `claim_evidence`    = observação lógica ligada a um claim (tenant-scoped);
 *   - `evidence`          = descritor material legado (global, street view).
 *
 * O vínculo é com `claim_evidence`, e NÃO com `evidence`: `evidence` é global
 * (sem tenant/RLS) e aceitar um FK para ela permitiria que um tenant
 * referenciasse material de outro. A FK composta (claim_evidence_id,
 * tenant_id) garante no PostgreSQL que o artefato pertence ao MESMO tenant da
 * observação. Sem UPDATE: o artefato é write-once.
 */
export const evidenceArtifact = pgTable(
  'evidence_artifact',
  {
    artifactId: uuid('artifact_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    claimEvidenceId: uuid('claim_evidence_id').notNull(),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: bytea('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    retentionUntil: timestamp('retention_until', { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.claimEvidenceId, t.tenantId],
      foreignColumns: [claimEvidence.claimEvidenceId, claimEvidence.tenantId],
      name: 'evidence_artifact_claim_evidence_tenant_fk',
    }).onDelete('restrict'),
    uniqueIndex('evidence_artifact_tenant_storage_key_uq').on(t.tenantId, t.storageKey),
    // Chave de apoio para a FK composta de `evidence_analysis`
    // (artifact_id, tenant_id): a análise só pode apontar para um artefato do
    // MESMO tenant.
    uniqueIndex('evidence_artifact_id_tenant_uq').on(t.artifactId, t.tenantId),
    index('evidence_artifact_tenant_claim_idx').on(t.tenantId, t.claimEvidenceId),
    index('evidence_artifact_retention_idx').on(t.retentionUntil),
    check('evidence_artifact_size_ck', sql`${t.sizeBytes} BETWEEN 1 AND 52428800`),
    check('evidence_artifact_sha256_ck', sql`octet_length(${t.sha256}) = 32`),
    check('evidence_artifact_content_type_ck', sql`length(${t.contentType}) BETWEEN 1 AND 255`),
    check('evidence_artifact_storage_key_ck', sql`length(${t.storageKey}) BETWEEN 1 AND 512`),
    check(
      'evidence_artifact_storage_key_tenant_ck',
      sql`${t.storageKey} LIKE 'tenants/' || ${t.tenantId}::text || '/evidence/%'`,
    ),
  ],
)

export type EvidenceArtifact = typeof evidenceArtifact.$inferSelect
export type NewEvidenceArtifact = typeof evidenceArtifact.$inferInsert
