import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { valModeEnum, valStatusEnum, verdictEnum } from './enums.js'
import { legalBasis } from './reference-receita.js'
import { subject } from './subjects.js'
import { apiKey, tenant } from './tenancy.js'

/**
 * Validation é a unidade de trabalho (fast/deep) e a raiz do histórico. É
 * particionada por `created_at`, por isso a PK é composta.
 *
 * `policy_hash`/`scorer_version`/`evidence_set_hash` são o binding IMUTÁVEL da
 * assertion; `last_evaluated_*` são o estado mutável da última avaliação do deep
 * path (A3/C1).
 */
export const validation = pgTable(
  'validation',
  {
    validationId: uuid('validation_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subject.subjectId),
    addressId: uuid('address_id'),
    mode: valModeEnum('mode').notNull(),
    status: valStatusEnum('status').notNull(),
    verdict: verdictEnum('verdict'),
    score: real('score'),
    confidence: real('confidence'),
    policyVersion: text('policy_version').notNull(),
    legalBasis: text('legal_basis')
      .notNull()
      .references(() => legalBasis.code),
    consentRef: text('consent_ref'),
    userId: text('user_id'),
    // V-1: credencial que originou a asserção (nullable: histórico e batch).
    apiKeyId: uuid('api_key_id'),
    // V-1: snapshot COMPLETO da autoridade efetiva associado à validation
    // (gravado na criação e imutável). A credencial filtra capacidades
    // administrativas (ADR-0030).
    issuerScopes: text('issuer_scopes').array(),
    // V-5/§8/§9: binding de policy, scorer e conjunto de evidências.
    policyHash: text('policy_hash'),
    scorerVersion: text('scorer_version'),
    lastEvaluatedPolicyHash: text('last_evaluated_policy_hash'),
    lastEvaluatedScorerVersion: text('last_evaluated_scorer_version'),
    evidenceSetHash: text('evidence_set_hash'),
    // F3: estado durável da reavaliação após a consulta fiscal (tick fiscal).
    // `pending` antes de materializar a evidência fiscal; `completed` só depois
    // do deepEnrich. O GET expõe ao cliente (migration 0045).
    fiscalReassessment: text('fiscal_reassessment'),
    idempotencyKey: text('idempotency_key'),
    workflowId: text('workflow_id'),
    explanation: jsonb('explanation').$type<{
      summary?: string
      code?: string
      supporting_evidence?: string[]
      contradicting_evidence?: string[]
    } | null>(),
    deepContext: jsonb('deep_context').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.validationId, t.createdAt] }),
    index('idx_validation_tenant_time').on(t.tenantId, t.createdAt.desc()),
    index('idx_validation_subject').on(t.subjectId, t.createdAt.desc()),
    // FK composta (V-1): valida existência E coerência de tenant do issuer.
    foreignKey({
      columns: [t.apiKeyId, t.tenantId],
      foreignColumns: [apiKey.apiKeyId, apiKey.tenantId],
      name: 'validation_api_key_tenant_fk',
    }),
    // FK composta (§14.8/§19): garante que o subject é do MESMO tenant.
    foreignKey({
      columns: [t.subjectId, t.tenantId],
      foreignColumns: [subject.subjectId, subject.tenantId],
      name: 'validation_subject_tenant_fk',
    }),
    check(
      'validation_fiscal_reassessment_ck',
      sql`${t.fiscalReassessment} IS NULL OR ${t.fiscalReassessment} IN ('pending', 'completed')`,
    ),
  ],
)

/** Replay idempotente de validação por tenant + `Idempotency-Key`. */
export const validationIdempotency = pgTable(
  'validation_idempotency',
  {
    tenantId: uuid('tenant_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    validationId: uuid('validation_id').notNull(),
    requestHash: text('request_hash'),
    responseAddress: jsonb('response_address').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.idempotencyKey] })],
)

export type Validation = typeof validation.$inferSelect
export type NewValidation = typeof validation.$inferInsert
export type ValidationIdempotency = typeof validationIdempotency.$inferSelect
export type NewValidationIdempotency = typeof validationIdempotency.$inferInsert
