import { boolean, char, date, integer, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { bytea, geographyPoint } from './custom-types.js'
import { geoPrecisionEnum } from './enums.js'

/** Endereço canônico (um por `building_key`), insumo dos sinais e perfis. */
export const canonicalAddress = pgTable('canonical_address', {
  addressId: uuid('address_id').primaryKey(),
  buildingKey: bytea('building_key').notNull().unique(),
  countryCode: char('country_code', { length: 2 }).notNull().default('BR'),
  uf: char('uf', { length: 2 }),
  municipioIbge: integer('municipio_ibge'),
  cep: char('cep', { length: 8 }),
  logradouroNorm: text('logradouro_norm'),
  numero: text('numero'),
  bairroNorm: text('bairro_norm'),
  geom: geographyPoint('geom'),
  geoPrecision: geoPrecisionEnum('geo_precision').notNull().default('NONE'),
  geoConsensusM: real('geo_consensus_m'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
})

/** Perfil agregado do endereço (computed pelo ingestor, lido pelo fast path). */
export const addressProfile = pgTable('address_profile', {
  addressId: uuid('address_id')
    .primaryKey()
    .references(() => canonicalAddress.addressId),
  activeCnpjCount: integer('active_cnpj_count').notNull(),
  activeMatrizCount: integer('active_matriz_count').notNull(),
  distinctCnaeDiv: integer('distinct_cnae_div').notNull(),
  distinctPartnerCount: integer('distinct_partner_count').notNull(),
  topPartnerShare: real('top_partner_share'),
  isKnownShared: boolean('is_known_shared').notNull().default(false),
  sharedKind: text('shared_kind'),
  openedLast12m: integer('opened_last_12m').notNull().default(0),
  computedFromSnapshot: date('computed_from_snapshot', { mode: 'string' }).notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
})

export type CanonicalAddress = typeof canonicalAddress.$inferSelect
export type NewCanonicalAddress = typeof canonicalAddress.$inferInsert
export type AddressProfile = typeof addressProfile.$inferSelect
export type NewAddressProfile = typeof addressProfile.$inferInsert
