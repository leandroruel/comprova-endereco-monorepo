import type { CnefeCoordReader, CnefeReader } from '@comprova/core'
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../client.js'
import { refCnefeAddress } from '../schemas/reference-address.js'

const addressColumns = {
  cnefeId: refCnefeAddress.cnefeId,
  especie: refCnefeAddress.especie,
  cep: refCnefeAddress.cep,
} as const

/** Busca endereço no CNEFE: número exato quando houver, senão só o logradouro. */
export const makeCnefeReader = (db: Db): CnefeReader => ({
  findAddress: async ({ municipioIbge, logradouroNorm, numero }) => {
    if (numero.length > 0) {
      const exact = await db
        .select(addressColumns)
        .from(refCnefeAddress)
        .where(
          and(
            eq(refCnefeAddress.municipioIbge, municipioIbge),
            sql`${refCnefeAddress.logradouroNorm} = ${logradouroNorm}`,
            sql`${refCnefeAddress.numero} = ${numero}`,
          ),
        )
        .limit(1)
      const row = exact[0]
      if (row !== undefined) {
        return { cnefeId: row.cnefeId, especie: row.especie, cep: row.cep, exactNumber: true }
      }
    }
    const streetOnly = await db
      .select(addressColumns)
      .from(refCnefeAddress)
      .where(
        and(
          eq(refCnefeAddress.municipioIbge, municipioIbge),
          sql`${refCnefeAddress.logradouroNorm} = ${logradouroNorm}`,
        ),
      )
      .limit(1)
    const row = streetOnly[0]
    return row === undefined
      ? null
      : { cnefeId: row.cnefeId, especie: row.especie, cep: row.cep, exactNumber: false }
  },
})

/** Coordenada do CNEFE (PostGIS → lat/lon). */
export const makeCnefeCoordReader = (db: Db): CnefeCoordReader => ({
  coordFor: async ({ municipioIbge, logradouroNorm, numero }) => {
    const rows = await db
      .select({
        lat: sql`ST_Y(geom::geometry)`,
        lon: sql`ST_X(geom::geometry)`,
      })
      .from(refCnefeAddress)
      .where(
        and(
          eq(refCnefeAddress.municipioIbge, municipioIbge),
          sql`${refCnefeAddress.logradouroNorm} = ${logradouroNorm}`,
          sql`${refCnefeAddress.numero} = ${numero}`,
        ),
      )
      .limit(1)
    const row = rows[0]
    return row === undefined ? null : { lat: Number(row.lat), lon: Number(row.lon) }
  },
})
