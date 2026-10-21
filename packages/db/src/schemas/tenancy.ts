import { sql } from 'drizzle-orm'
import { bigint, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { bytea } from './custom-types.js'

/** Raiz de tenancy: todo dado de negócio é escopado por um tenant. */
export const tenant = pgTable('tenant', {
  tenantId: uuid('tenant_id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  rateLimitRps: integer('rate_limit_rps').notNull().default(50),
  burst: integer('burst').notNull().default(100),
  monthlyQuota: bigint('monthly_quota', { mode: 'number' }),
  dataRegion: text('data_region').notNull().default('sa-east-1'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Credencial de acesso à API (HMAC do segredo, nunca o segredo).
 *
 * `scopes` tem default mínimo (`validate:read`/`validate:write`): `keys:write` é
 * administrativo e opt-in, não concedido automaticamente (ADR-0030).
 */
export const apiKey = pgTable(
  'api_key',
  {
    apiKeyId: uuid('api_key_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: bytea('key_hash').notNull(),
    scopes: text('scopes').array().notNull().default(['validate:read', 'validate:write']),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_key_prefix_uq')
      .on(t.keyPrefix)
      .where(sql`revoked_at IS NULL`),
    // Chave única de apoio para a FK composta de `validation` (V-1):
    // garante que validation.tenant_id = api_key.tenant_id.
    unique('api_key_id_tenant_uq').on(t.apiKeyId, t.tenantId),
  ],
)

export type Tenant = typeof tenant.$inferSelect
export type NewTenant = typeof tenant.$inferInsert
export type ApiKey = typeof apiKey.$inferSelect
export type NewApiKey = typeof apiKey.$inferInsert
