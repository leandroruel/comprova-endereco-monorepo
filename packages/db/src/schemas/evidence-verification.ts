import { sql } from 'drizzle-orm'
import { check, foreignKey, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { evidenceAnalysis } from './evidence-analysis.js'
import { tenant } from './tenancy.js'

/**
 * F1.3 — estado operacional de retry da verificação do documento enviado.
 *
 * A verificação é materializada em `claim_evidence`, que é append-only. Uma
 * falha/skip não produz linha de evidência, então sem este estado o mesmo
 * candidato (o mais antigo globalmente) seria selecionado em todo tick. A
 * tabela guarda apenas o backoff exponencial por `analysis_id`; não contém PII,
 * endereço, titular nem o resultado extraído. Ela é acessada só pelo worker com
 * o pool administrativo; `app_user` não recebe grant.
 *
 * A FK composta garante que a tentativa pertence ao mesmo tenant da análise.
 * A remoção do artefato (retenção) apaga a análise e, em cascata, a tentativa.
 */
export const evidenceVerificationAttempt = pgTable(
  'evidence_verification_attempt',
  {
    analysisId: uuid('analysis_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    attempts: integer('attempts').notNull().default(1),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastErrorCode: text('last_error_code'),
  },
  (t) => [
    foreignKey({
      columns: [t.analysisId, t.tenantId],
      foreignColumns: [evidenceAnalysis.analysisId, evidenceAnalysis.tenantId],
      name: 'evidence_verification_attempt_analysis_tenant_fk',
    }).onDelete('cascade'),
    index('evidence_verification_attempt_next_idx').on(t.nextAttemptAt),
    check('evidence_verification_attempt_attempts_ck', sql`${t.attempts} >= 1`),
  ],
)

export type EvidenceVerificationAttempt = typeof evidenceVerificationAttempt.$inferSelect
export type NewEvidenceVerificationAttempt = typeof evidenceVerificationAttempt.$inferInsert
