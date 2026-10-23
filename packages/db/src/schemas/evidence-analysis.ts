import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import type { DocumentAnalysisResult } from '@comprova/core'
import { evidenceArtifact } from './evidence-artifact.js'
import { tenant } from './tenancy.js'

/**
 * F1.2 — observação estruturada da análise do documento.
 *
 * `claim_evidence` é imutável (trigger `claim_evidence_guard_trg`) e tem no
 * máximo um documento do cliente por claim; `evidence_artifact` é write-once.
 * Por isso o resultado da análise nasce nesta tabela append-only, uma linha por
 * (`artifact_id`, `analyzer`, `analyzer_version`, `contract_version`). Uma nova
 * versão do analisador/contrato cria uma nova linha e preserva a anterior.
 *
 * A linha é tenant-scoped e participa da retenção do artefato: a FK composta
 * com `ON DELETE CASCADE` remove a análise (que contém PII extraída) junto do
 * artefato bruto.
 */
export const evidenceAnalysis = pgTable(
  'evidence_analysis',
  {
    analysisId: uuid('analysis_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    artifactId: uuid('artifact_id').notNull(),
    analyzer: text('analyzer').notNull(),
    analyzerVersion: text('analyzer_version').notNull(),
    contractVersion: text('contract_version').notNull(),
    status: text('status').notNull(),
    result: jsonb('result').$type<DocumentAnalysisResult | null>(),
    errorCodes: text('error_codes').array().notNull().default([]),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    analyzedAt: timestamp('analyzed_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.artifactId, t.tenantId],
      foreignColumns: [evidenceArtifact.artifactId, evidenceArtifact.tenantId],
      name: 'evidence_analysis_artifact_tenant_fk',
    }).onDelete('cascade'),
    unique('evidence_analysis_artifact_analyzer_uq').on(
      t.artifactId,
      t.analyzer,
      t.analyzerVersion,
      t.contractVersion,
    ),
    index('evidence_analysis_status_idx').on(t.status, t.updatedAt),
    index('evidence_analysis_tenant_artifact_idx').on(t.tenantId, t.artifactId),
    check(
      'evidence_analysis_status_ck',
      sql`${t.status} IN ('pending','analyzing','completed','inconclusive','unsupported','unavailable','failed')`,
    ),
    check('evidence_analysis_attempts_ck', sql`${t.attempts} >= 0`),
    check(
      'evidence_analysis_terminal_result_ck',
      sql`(${t.status} IN ('pending','analyzing') AND ${t.result} IS NULL) OR (${t.status} IN ('completed','inconclusive','unsupported','unavailable','failed') AND ${t.result} IS NOT NULL AND ${t.analyzedAt} IS NOT NULL AND (${t.result}->>'status') IS NOT DISTINCT FROM ${t.status})`,
    ),
  ],
)

export type EvidenceAnalysis = typeof evidenceAnalysis.$inferSelect
export type NewEvidenceAnalysis = typeof evidenceAnalysis.$inferInsert
