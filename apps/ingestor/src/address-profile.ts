import { sql } from 'drizzle-orm'
import type { Db } from '@comprova/db'

export const recomputeAddressProfiles = async (db: Db): Promise<number> => {
  const result = (await db.execute(sql`
    WITH address_cnpj_stats AS (
      SELECT
        ca.address_id,
        COUNT(DISTINCT e.cnpj_basico) FILTER (WHERE e.situacao_cadastral = 2) AS active_cnpj_count,
        COUNT(DISTINCT e.cnpj_basico) FILTER (WHERE e.situacao_cadastral = 2 AND e.matriz_filial = 1) AS active_matriz_count,
        COUNT(DISTINCT SUBSTRING(e.cnae_principal, 1, 2)) FILTER (WHERE e.situacao_cadastral = 2) AS distinct_cnae_div,
        COUNT(DISTINCT e.cnpj_basico) FILTER (
          WHERE e.situacao_cadastral = 2
            AND e.data_abertura >= (CURRENT_DATE - INTERVAL '12 months')
        ) AS opened_last_12m
      FROM canonical_address ca
      JOIN ref_receita_estabelecimento e
        ON e.building_key = ca.building_key
      GROUP BY ca.address_id
    )
    INSERT INTO address_profile (
      address_id, active_cnpj_count, active_matriz_count, distinct_cnae_div,
      distinct_partner_count, is_known_shared, opened_last_12m, computed_from_snapshot
    )
    SELECT
      s.address_id,
      s.active_cnpj_count,
      s.active_matriz_count,
      s.distinct_cnae_div,
      0 AS distinct_partner_count,
      EXISTS (
        SELECT 1 FROM ref_known_shared_address k
        WHERE k.building_key = (SELECT building_key FROM canonical_address WHERE address_id = s.address_id)
      ) AS is_known_shared,
      s.opened_last_12m,
      '2026-09-01'::date
    FROM address_cnpj_stats s
    ON CONFLICT (address_id) DO UPDATE SET
      active_cnpj_count = EXCLUDED.active_cnpj_count,
      active_matriz_count = EXCLUDED.active_matriz_count,
      distinct_cnae_div = EXCLUDED.distinct_cnae_div,
      opened_last_12m = EXCLUDED.opened_last_12m,
      computed_from_snapshot = EXCLUDED.computed_from_snapshot,
      computed_at = now()
  `)) as unknown as { rowCount?: number } | readonly unknown[]
  if (Array.isArray(result)) return result.length
  return Number((result as { rowCount?: number })?.rowCount ?? 0)
}

export const seedCanonicalAddresses = async (db: Db): Promise<number> => {
  const result = (await db.execute(sql`
    INSERT INTO canonical_address (
      address_id, building_key, country_code, uf, municipio_ibge, cep,
      logradouro_norm, numero, bairro_norm, first_seen_at
    )
    SELECT DISTINCT ON (e.building_key)
      gen_random_uuid(),
      e.building_key,
      'BR',
      e.uf,
      NULL,
      e.cep,
      NULL,
      NULL,
      NULL,
      now()
    FROM ref_receita_estabelecimento e
    WHERE e.building_key IS NOT NULL
      AND e.uf IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM canonical_address ca WHERE ca.building_key = e.building_key
      )
  `)) as unknown as { rowCount?: number } | readonly unknown[]
  if (Array.isArray(result)) return result.length
  return Number((result as { rowCount?: number })?.rowCount ?? 0)
}
