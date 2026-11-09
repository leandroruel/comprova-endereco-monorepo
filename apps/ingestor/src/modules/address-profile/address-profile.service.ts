import { sql } from '@comprova/db'
import type { Db } from '@comprova/db'
import { rowCountOf } from '../../lib/db-result.js'

/**
 * Perfis agregados de endereço — a única junção natural entre os domínios
 * operacional (`canonical_address`/`address_profile`) e de referência
 * (`ref_receita_estabelecimento`, `ref_known_shared_address`). Com databases
 * separados a junção não pode existir em uma única sentença: os agregados são
 * computados na conexão de referência e materializados, em lotes, na conexão
 * operacional. Nenhuma transação abrange os dois lados.
 */

const PROFILE_BATCH_SIZE = 5_000
const SEED_PAGE_SIZE = 5_000

/** Recalcula `address_profile` a partir dos estabelecimentos ativos por endereço canônico. */
export const recomputeAddressProfiles = async (appDb: Db, refDb: Db): Promise<number> => {
  // 1. Endereços canônicos vivem no database operacional.
  const addresses = await appDb.execute(
    sql`SELECT address_id, encode(building_key, 'hex') AS bk FROM canonical_address WHERE building_key IS NOT NULL`,
  )
  const targets = (
    addresses as unknown as readonly {
      address_id: string
      bk: string
    }[]
  ).filter((r) => r.bk !== '')
  if (targets.length === 0) return 0

  let written = 0
  for (let offset = 0; offset < targets.length; offset += PROFILE_BATCH_SIZE) {
    const batch = targets.slice(offset, offset + PROFILE_BATCH_SIZE)
    const hexKeys: string[] = batch.map((r) => r.bk)

    // 2. Agregados contra as bases de referência, por building_key, em uma
    //    única sentença autocontida (keys passadas via array, sem temp table).
    const statsRows = await refDb.execute(sql`
      SELECT
        t.bk,
        COUNT(DISTINCT e.cnpj_basico) FILTER (WHERE e.situacao_cadastral = 2) AS active_cnpj_count,
        COUNT(DISTINCT e.cnpj_basico) FILTER (WHERE e.situacao_cadastral = 2 AND e.matriz_filial = 1) AS active_matriz_count,
        COUNT(DISTINCT SUBSTRING(e.cnae_principal, 1, 2)) FILTER (WHERE e.situacao_cadastral = 2) AS distinct_cnae_div,
        COUNT(DISTINCT e.cnpj_basico) FILTER (
          WHERE e.situacao_cadastral = 2
            AND e.data_abertura >= (CURRENT_DATE - INTERVAL '12 months')
        ) AS opened_last_12m,
        EXISTS (
          SELECT 1 FROM ref_known_shared_address k WHERE k.building_key = decode(t.bk, 'hex')
        ) AS is_known_shared
      FROM unnest(${hexKeys}::text[]) AS t(bk)
      JOIN ref_receita_estabelecimento e
        ON e.building_key = decode(t.bk, 'hex')
      GROUP BY t.bk
    `)
    // Endereços sem nenhum estabelecimento na referência também ganham linha
    // (is_known_shared ainda pode ser true).
    const statsByBk = new Map(
      (
        statsRows as unknown as readonly {
          bk: string
          active_cnpj_count: number | string
          active_matriz_count: number | string
          distinct_cnae_div: number | string
          opened_last_12m: number | string
          is_known_shared: boolean
        }[]
      ).map((r) => [r.bk, r]),
    )
    const missing = hexKeys.filter((bk) => !statsByBk.has(bk))
    type StatRow = {
      bk: string
      active_cnpj_count: number | string
      active_matriz_count: number | string
      distinct_cnae_div: number | string
      opened_last_12m: number | string
      is_known_shared: boolean
    }
    const lonelyRows: readonly StatRow[] =
      missing.length === 0
        ? []
        : ((await refDb.execute(sql`
            SELECT
              t.bk,
              0::bigint AS active_cnpj_count,
              0::bigint AS active_matriz_count,
              0::bigint AS distinct_cnae_div,
              0::bigint AS opened_last_12m,
              EXISTS (
                SELECT 1 FROM ref_known_shared_address k WHERE k.building_key = decode(t.bk, 'hex')
              ) AS is_known_shared
            FROM unnest(${missing}::text[]) AS t(bk)
          `)) as unknown as readonly StatRow[])

    const rows: readonly StatRow[] = [...(statsRows as unknown as readonly StatRow[]), ...lonelyRows]

    // 3. Upsert no database operacional, em lote.
    const batchById = new Map(batch.map((r) => [r.bk, r.address_id]))
    const values = rows.map((r) => {
      const addressId = batchById.get(r.bk)
      if (addressId === undefined)
        throw new Error(`building_key ${r.bk} not found in canonical_address batch`)
      return sql`(
        ${addressId}::uuid,
        ${Number(r.active_cnpj_count)}::int,
        ${Number(r.active_matriz_count)}::int,
        ${Number(r.distinct_cnae_div)}::int,
        0,
        ${r.is_known_shared}::boolean,
        ${Number(r.opened_last_12m)}::int,
        '2026-09-01'::date
      )`
    })
    const result = await appDb.execute(sql`
      INSERT INTO address_profile (
        address_id, active_cnpj_count, active_matriz_count, distinct_cnae_div,
        distinct_partner_count, is_known_shared, opened_last_12m, computed_from_snapshot
      )
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (address_id) DO UPDATE SET
        active_cnpj_count = EXCLUDED.active_cnpj_count,
        active_matriz_count = EXCLUDED.active_matriz_count,
        distinct_cnae_div = EXCLUDED.distinct_cnae_div,
        opened_last_12m = EXCLUDED.opened_last_12m,
        is_known_shared = EXCLUDED.is_known_shared,
        computed_from_snapshot = EXCLUDED.computed_from_snapshot,
        computed_at = now()
    `)
    written += rowCountOf(result)
  }
  return written
}

/** Cria endereços canônicos para cada `building_key` ainda não registrado. */
export const seedCanonicalAddresses = async (appDb: Db, refDb: Db): Promise<number> => {
  // 1. Chaves já conhecidas no database operacional (limite da paginação).
  const known = await appDb.execute(
    sql`SELECT encode(building_key, 'hex') AS bk FROM canonical_address WHERE building_key IS NOT NULL`,
  )
  const knownKeys = new Set((known as unknown as readonly { bk: string }[]).map((r) => r.bk))

  // 2. Pagina as chaves distintas na base de referência (keyset por building_key)
  //    e insere as novas na conexão operacional.
  let written = 0
  let cursor = ''
  for (;;) {
    const pageRows = (await refDb.execute(sql`
      SELECT encode(building_key, 'hex') AS bk, uf, cep
      FROM ref_receita_estabelecimento
      WHERE building_key IS NOT NULL
        AND uf IS NOT NULL
        AND building_key > decode(${cursor}, 'hex')
      ORDER BY building_key
      LIMIT ${SEED_PAGE_SIZE}
    `)) as unknown as readonly { bk: string; uf: string; cep: string | null }[]
    if (pageRows.length === 0) break
    const lastRow = pageRows[pageRows.length - 1]
    if (lastRow === undefined) break

    // Uma página não repete chaves (keyset com `>`); dentro da página,
    // distingue chaves possivelmente repetidas pelo mesmo building_key.
    const seenInPage = new Set<string>()
    const fresh = pageRows.filter((r) => {
      if (knownKeys.has(r.bk) || seenInPage.has(r.bk)) return false
      seenInPage.add(r.bk)
      return true
    })

    if (fresh.length > 0) {
      const values = fresh.map(
        (r) =>
          sql`(
          gen_random_uuid(),
          decode(${r.bk}, 'hex'),
          'BR',
          ${r.uf},
          NULL,
          ${r.cep},
          NULL,
          NULL,
          NULL,
          now()
        )`,
      )
      const result = await appDb.execute(sql`
        INSERT INTO canonical_address (
          address_id, building_key, country_code, uf, municipio_ibge, cep,
          logradouro_norm, numero, bairro_norm, first_seen_at
        )
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT DO NOTHING
      `)
      written += rowCountOf(result)
      for (const r of fresh) knownKeys.add(r.bk)
    }

    cursor = lastRow.bk
    if (pageRows.length < SEED_PAGE_SIZE) break
  }
  return written
}
