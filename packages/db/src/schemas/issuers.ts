import { sql } from 'drizzle-orm'
import { boolean, index, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { bytea } from './custom-types.js'
import { tenant } from './tenancy.js'

/**
 * Chave de assinatura do issuer de um tenant (FASE 14). Cada tenant tem a sua,
 * de modo que o comprometimento de uma chave não atinge os demais issuers.
 *
 * A tabela guarda SOMENTE material público e referências: a chave pública crua
 * (32 bytes), os metadados do método e, para chaves externas, a referência do
 * backend (`kms_key_reference`). A chave privada nunca é persistida — ela vive
 * em configuração/segredo externo (ou no KMS) e é associada aqui por
 * (`tenant_id`, `key_id`) (ADR-0026/ADR-0032). `issuer_scope` é o digest opaco
 * do tenant que aparece na URL do issuer; é o que permite ao endpoint público
 * resolver a chave pelo `issuer.id`.
 *
 * `active = false` marca a chave superada (rotação): ela deixa de assinar
 * credenciais novas, mas continua publicada para verificar as antigas. NÃO é
 * revogação — `revoked_at` é o hard stop (ADR-0029).
 */
export const issuerSigningKey = pgTable(
  'issuer_signing_key',
  {
    issuerSigningKeyId: uuid('issuer_signing_key_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    issuerScope: text('issuer_scope').notNull(),
    keyId: text('key_id').notNull(),
    algorithm: text('algorithm').notNull(),
    publicKey: bytea('public_key').notNull(),
    // Referência da chave no backend externo de assinatura (AWS KMS). NULL =
    // material local em `CREDENTIAL_SIGNING_KEYS`. É uma referência opaca, nunca
    // material privado; o KMS assina e a verificação pública continua local
    // (ADR-0032). Imutável depois de publicada (trigger da migration 0038) e
    // não é devolvida pelos endpoints públicos (eles selecionam colunas
    // explícitas).
    kmsKeyReference: text('kms_key_reference'),
    active: boolean('active').notNull().default(true),
    // `revoked_at` é o hard stop (ADR-0029): NULL = confiável; passado =
    // revogada/expirada; futuro = expiração agendada. A chave sai dos
    // documentos públicos a partir desse instante e o verificador falha
    // fechado. A revogação é monotônica (trigger na migration 0033).
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('issuer_signing_key_tenant_key_uq').on(t.tenantId, t.keyId),
    // No máximo uma chave ATIVA por tenant: a seleção da chave de emissão é
    // determinística (sem "qual das ativas?").
    uniqueIndex('issuer_signing_key_active_uq')
      .on(t.tenantId)
      .where(sql`active`),
    index('issuer_signing_key_scope_idx').on(t.issuerScope),
  ],
)

/** Status público de uma credencial emitida (ADR-0027). */
export const credentialStatus = pgTable(
  'credential_status',
  {
    credentialId: text('credential_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    issuerScope: text('issuer_scope').notNull(),
    status: text('status').$type<'ACTIVE' | 'REVOKED'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // Motivo auditável da revogação (`manual`, `superseded`); não é exposto no
    // endpoint público. `superseded` = o deep path produziu uma conclusão nova.
    revocationReason: text('revocation_reason'),
  },
  (t) => [index('credential_status_scope_idx').on(t.issuerScope)],
)

/**
 * Primeira emissão por validation (ADR-0024, Revisão pós-PR #5/B2). A
 * credencial continua NÃO persistida: guardamos só o instante da primeira prova
 * (`issued_at`) e o ponteiro público de status (`credential_id`). Reemitir a
 * mesma validation reassina com `proof.created = issued_at`, produzindo bytes
 * idênticos enquanto issuer/key/policy não mudarem.
 */
export const credentialIssuance = pgTable(
  'credential_issuance',
  {
    validationId: uuid('validation_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    issuerScope: text('issuer_scope').notNull(),
    credentialId: text('credential_id').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('credential_issuance_credential_uq').on(t.credentialId),
    index('credential_issuance_tenant_idx').on(t.tenantId),
  ],
)

export type IssuerSigningKey = typeof issuerSigningKey.$inferSelect
export type NewIssuerSigningKey = typeof issuerSigningKey.$inferInsert
export type CredentialStatus = typeof credentialStatus.$inferSelect
export type NewCredentialStatus = typeof credentialStatus.$inferInsert
export type CredentialIssuance = typeof credentialIssuance.$inferSelect
export type NewCredentialIssuance = typeof credentialIssuance.$inferInsert
