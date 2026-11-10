import { sql } from 'drizzle-orm'
import { check, foreignKey, index, pgTable, text, timestamp, uuid, unique } from 'drizzle-orm/pg-core'
import { bytea } from './custom-types.js'
import { holder } from './holder.js'
import { holderInformationRequest } from './holder-information-request.js'
import { tenant } from './tenancy.js'

/**
 * Token opaco de acesso do Holder (F4.2).
 *
 * O Holder não tem conta nem sessão: o token emitido pelo Verifier é a única
 * credencial. Nunca armazenamos o texto puro — apenas o prefixo indexado e o
 * HMAC-SHA-256 com pepper de domínio. A resolução acontece por uma função
 * SECURITY DEFINER restrita (migração 0058), porque o tenant só é conhecido
 * depois de validar o token.
 */
export const holderAccessToken = pgTable(
  'holder_access_token',
  {
    tokenId: uuid('token_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    holderId: uuid('holder_id').notNull(),
    holderInformationRequestId: uuid('holder_information_request_id').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    tokenHash: bytea('token_hash').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    firstAccessedAt: timestamp('first_accessed_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.holderId, t.tenantId],
      foreignColumns: [holder.holderId, holder.tenantId],
    }),
    foreignKey({
      columns: [t.holderInformationRequestId, t.tenantId],
      foreignColumns: [holderInformationRequest.id, holderInformationRequest.tenantId],
    }),
    check('holder_access_token_prefix_check', sql`char_length(token_prefix) BETWEEN 8 AND 64`),
    check('holder_access_token_hash_check', sql`octet_length(token_hash) = 32`),
    check('holder_access_token_expiry_check', sql`expires_at > created_at`),
    unique('holder_access_token_prefix_unique').on(t.tokenPrefix),
    index('holder_access_token_tenant_idx').on(t.tenantId),
    index('holder_access_token_request_idx').on(t.tenantId, t.holderInformationRequestId),
  ],
)

export type HolderAccessToken = typeof holderAccessToken.$inferSelect
export type NewHolderAccessToken = typeof holderAccessToken.$inferInsert
