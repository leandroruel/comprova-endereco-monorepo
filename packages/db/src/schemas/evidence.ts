import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { bytea } from './custom-types.js'

/**
 * Artefato material (arquivo/documento) de uma evidência. A retenção apaga o
 * artefato e anula os `evidence_id` que o referenciam, mas preserva o digest
 * (`sha256`) nos vínculos — ver `claim_evidence.evidence_sha256` (V-3).
 */
export const evidence = pgTable('evidence', {
  evidenceId: uuid('evidence_id').primaryKey(),
  kind: text('kind').notNull(),
  provider: text('provider').notNull(),
  s3Uri: text('s3_uri').notNull(),
  sha256: bytea('sha256').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  retentionUntil: timestamp('retention_until', { withTimezone: true }).notNull(),
})

export type Evidence = typeof evidence.$inferSelect
export type NewEvidence = typeof evidence.$inferInsert
