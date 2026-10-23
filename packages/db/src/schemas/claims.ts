import { sql } from 'drizzle-orm'
import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { canonicalAddress } from './addresses.js'
import { bytea } from './custom-types.js'
import {
  claimSubjectTypeEnum,
  claimTargetTypeEnum,
  claimTypeEnum,
  evidenceStanceEnum,
  stanceEnum,
} from './enums.js'
import { evidence } from './evidence.js'
import { subject } from './subjects.js'
import { tenant } from './tenancy.js'

/**
 * Claim = a proposição verificada (ex.: "esta empresa está neste endereço").
 * A FK composta garante que o subject pertence ao MESMO tenant (MÉDIO-5).
 */
export const claim = pgTable(
  'claim',
  {
    claimId: uuid('claim_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    validationId: uuid('validation_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    addressId: uuid('address_id').references(() => canonicalAddress.addressId),
    type: claimTypeEnum('type').notNull(),
    subjectType: claimSubjectTypeEnum('subject_type').notNull(),
    targetType: claimTargetTypeEnum('target_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.subjectId, t.tenantId],
      foreignColumns: [subject.subjectId, subject.tenantId],
      name: 'claim_subject_tenant_fk',
    }).onDelete('cascade'),
  ],
)

/**
 * Vínculo claim ↔ evidência. `evidence_sha256` sobrevive à retenção do artefato
 * (que anula `evidence_id`), preservando a prova material (V-3).
 */
export const claimEvidence = pgTable(
  'claim_evidence',
  {
    claimEvidenceId: uuid('claim_evidence_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claim.claimId),
    signalId: uuid('signal_id'),
    evidenceId: uuid('evidence_id').references(() => evidence.evidenceId),
    evidenceSha256: bytea('evidence_sha256'),
    checker: text('checker').notNull(),
    checkerVersion: text('checker_version').notNull(),
    stance: evidenceStanceEnum('stance').notNull(),
    strength: real('strength').notNull(),
    confidence: real('confidence').notNull(),
    source: text('source').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    ttlSeconds: integer('ttl_seconds').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // MÉDIO-3: 1 claim + 1 signal = 1 claim_evidence.
  // A chave (claim_evidence_id, tenant_id) existe para a FK composta de
  // `evidence_artifact` (ADR-0035): o artefato só pode apontar para uma
  // observação do MESMO tenant.
  (t) => [
    uniqueIndex('idx_claim_evidence_claim_signal_uq')
      .on(t.claimId, t.signalId)
      .where(sql`signal_id IS NOT NULL`),
    // F1.1: no máximo um documento enviado pelo cliente por claim. Outras
    // fontes (fiscal, registry) usam `source` diferente e continuam livres.
    uniqueIndex('idx_claim_evidence_customer_document_uq')
      .on(t.claimId)
      .where(sql`source = 'customer_submitted_document'`),
    // F1.3: uma verificação por claim + checker + versão. A versão inclui
    // analyzer_version/contract_version; nova versão não sobrescreve a antiga.
    uniqueIndex('idx_claim_evidence_uploaded_verification_uq')
      .on(t.claimId, t.checker, t.checkerVersion)
      .where(sql`source = 'uploaded_document'`),
    // Leitura corrente do GET (verificação mais recente do claim).
    index('idx_claim_evidence_uploaded_verification_read_idx')
      .on(t.claimId, t.observedAt, t.createdAt)
      .where(sql`source = 'uploaded_document'`),
    unique('claim_evidence_id_tenant_uq').on(t.claimEvidenceId, t.tenantId),
  ],
)

/** Sinal bruto de um checker, particionado por `created_at` (PK composta). */
export const signal = pgTable(
  'signal',
  {
    signalId: uuid('signal_id').notNull(),
    validationId: uuid('validation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    checkerId: text('checker_id').notNull(),
    checkerVersion: text('checker_version').notNull(),
    stance: stanceEnum('stance').notNull(),
    strength: real('strength').notNull(),
    confidence: real('confidence').notNull(),
    source: text('source').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    ttlSeconds: integer('ttl_seconds').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    evidenceId: uuid('evidence_id'),
  },
  (t) => [primaryKey({ columns: [t.signalId, t.createdAt] })],
)

/** Cache de sinal por endereço (evita repetir checker caro dentro do TTL). */
export const addressSignalCache = pgTable('address_signal_cache', {
  addressId: uuid('address_id')
    .notNull()
    .references(() => canonicalAddress.addressId),
  checkerId: text('checker_id').notNull(),
  checkerVersion: text('checker_version').notNull(),
  stance: stanceEnum('stance').notNull(),
  strength: real('strength').notNull(),
  confidence: real('confidence').notNull(),
  source: text('source').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  evidenceId: uuid('evidence_id'),
})

export type Claim = typeof claim.$inferSelect
export type NewClaim = typeof claim.$inferInsert
export type ClaimEvidence = typeof claimEvidence.$inferSelect
export type NewClaimEvidence = typeof claimEvidence.$inferInsert
export type Signal = typeof signal.$inferSelect
export type NewSignal = typeof signal.$inferInsert
export type AddressSignalCache = typeof addressSignalCache.$inferSelect
export type NewAddressSignalCache = typeof addressSignalCache.$inferInsert
