import { customType } from 'drizzle-orm/pg-core'

/**
 * Tipos de coluna que o Drizzle não traz de fábrica.
 *
 * Ficam fora dos módulos de schema (e não são reexportados pelo pacote): são
 * detalhe de mapeamento SQL↔TS, não parte do contrato público das tabelas.
 */

/** `bytea` cru. Usado para digests, chaves e material público de assinatura. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

/** `inet` (endereço IP de auditoria). */
export const inet = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'inet'
  },
})

/** `geography(Point,4326)` do PostGIS. */
export const geographyPoint = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'geography(Point,4326)'
  },
})
