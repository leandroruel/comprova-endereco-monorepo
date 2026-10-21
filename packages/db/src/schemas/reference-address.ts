import { bigint, char, integer, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core'
import { bytea, geographyPoint } from './custom-types.js'

/** Endereço do CNEFE (IBGE), com geometria PostGIS. */
export const refCnefeAddress = pgTable('ref_cnefe_address', {
  cnefeId: bigint('cnefe_id', { mode: 'number' }).primaryKey(),
  uf: char('uf', { length: 2 }).notNull(),
  municipioIbge: integer('municipio_ibge').notNull(),
  cep: char('cep', { length: 8 }),
  logradouroNorm: text('logradouro_norm').notNull(),
  numero: text('numero'),
  complementoNorm: text('complemento_norm'),
  especie: smallint('especie'),
  geom: geographyPoint('geom').notNull(),
  censusYear: smallint('census_year').notNull(),
})

/** CEP consolidado (fonte variável: BrasilAPI, CNEFE, …). */
export const refCep = pgTable('ref_cep', {
  cep: char('cep', { length: 8 }).primaryKey(),
  uf: char('uf', { length: 2 }).notNull(),
  municipioIbge: integer('municipio_ibge'),
  localidade: text('localidade'),
  bairro: text('bairro'),
  logradouroNorm: text('logradouro_norm'),
  geom: geographyPoint('geom'),
  source: text('source').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Endereços sabidamente compartilhados (ex.: shopping, coworking). */
export const refKnownSharedAddress = pgTable('ref_known_shared_address', {
  buildingKey: bytea('building_key').primaryKey(),
  kind: text('kind').notNull(),
  source: text('source').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type RefCnefeAddress = typeof refCnefeAddress.$inferSelect
export type NewRefCnefeAddress = typeof refCnefeAddress.$inferInsert
export type RefCep = typeof refCep.$inferSelect
export type NewRefCep = typeof refCep.$inferInsert
export type RefKnownSharedAddress = typeof refKnownSharedAddress.$inferSelect
export type NewRefKnownSharedAddress = typeof refKnownSharedAddress.$inferInsert
