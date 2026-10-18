import { cacheable, sql } from '@comprova/db'
import type { CacheStore, Db } from '@comprova/db'
import type { MetaPayload } from './meta.schema.js'

// `MAX()` nas colunas de versão não tem índice: cada execução varre a tabela.
// O payload é cacheado por 5 min para não repetir a varredura a cada chamada;
// ver ADR-0021 (limitação conhecida e próximo passo).
const META_CACHE_KEY = 'meta:datasets:v1'
const META_CACHE_TTL_SECONDS = 300

const firstRow = <T>(rows: unknown): T | undefined => (rows as readonly T[])[0]

const isoOrNull = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString()
  return typeof value === 'string' ? value : null
}

export const getDatasetMeta = async (db: Db, cache: CacheStore): Promise<MetaPayload> =>
  cacheable(cache, META_CACHE_KEY, META_CACHE_TTL_SECONDS, async () => {
    const [estabelecimento, empresa, socio, cnefe, cep, knownShared, profile] = await Promise.all([
      db.execute(sql`SELECT MAX(snapshot_month)::text AS snapshot_month FROM ref_receita_estabelecimento`),
      db.execute(sql`SELECT MAX(snapshot_month)::text AS snapshot_month FROM ref_receita_empresa`),
      db.execute(sql`SELECT MAX(snapshot_month)::text AS snapshot_month FROM ref_receita_socio`),
      db.execute(sql`SELECT MAX(census_year)::int AS census_year FROM ref_cnefe_address`),
      db.execute(sql`
        SELECT MAX(updated_at) AS updated_at, array_agg(DISTINCT source ORDER BY source) AS sources
        FROM ref_cep
      `),
      db.execute(sql`
        SELECT MAX(created_at) AS created_at, array_agg(DISTINCT source ORDER BY source) AS sources
        FROM ref_known_shared_address
      `),
      db.execute(
        sql`SELECT MAX(computed_from_snapshot)::text AS computed_from_snapshot FROM address_profile`,
      ),
    ])

    const snapshotOf = (rows: unknown): string | null =>
      firstRow<{ snapshot_month: string | null }>(rows)?.snapshot_month ?? null
    const sourcesOf = (rows: unknown): string[] => firstRow<{ sources: string[] | null }>(rows)?.sources ?? []

    return {
      datasets: {
        ref_receita_estabelecimento: { snapshot_month: snapshotOf(estabelecimento) },
        ref_receita_empresa: { snapshot_month: snapshotOf(empresa) },
        ref_receita_socio: { snapshot_month: snapshotOf(socio) },
        ref_cnefe_address: {
          census_year: firstRow<{ census_year: number | null }>(cnefe)?.census_year ?? null,
        },
        ref_cep: {
          updated_at: isoOrNull(firstRow<{ updated_at: unknown }>(cep)?.updated_at),
          sources: sourcesOf(cep),
        },
        ref_known_shared_address: {
          created_at: isoOrNull(firstRow<{ created_at: unknown }>(knownShared)?.created_at),
          sources: sourcesOf(knownShared),
        },
        address_profile: {
          computed_from_snapshot:
            firstRow<{ computed_from_snapshot: string | null }>(profile)?.computed_from_snapshot ?? null,
        },
      },
    }
  })
