import type { PartnerGraphReader } from '@comprova/core'
import { sql } from 'drizzle-orm'
import type { Db } from '../client.js'

/**
 * Grafo de sócios no endereço, numa única query: CNPJs co-localizados, quantos
 * compartilham sócio com o sujeito e aberturas recentes (12 meses).
 */
export const makePartnerGraphReader = (db: Db): PartnerGraphReader => ({
  statsFor: async ({ buildingKey, cnpjBasico }) => {
    const result = (await db.execute(sql`
      WITH co_located AS (
        SELECT DISTINCT e.cnpj_basico
        FROM ref_receita_estabelecimento e
        WHERE e.building_key = ${Buffer.from(buildingKey)}
          AND e.situacao_cadastral = 2
          AND e.cnpj_basico <> ${cnpjBasico}
      ),
      subject_partners AS (
        SELECT s.partner_key
        FROM ref_receita_socio s
        WHERE s.cnpj_basico = ${cnpjBasico}
      ),
      colocated_partners AS (
        SELECT s.cnpj_basico, s.partner_key
        FROM ref_receita_socio s
        JOIN co_located c ON s.cnpj_basico = c.cnpj_basico
      ),
      recent_openings AS (
        SELECT COUNT(*)::int AS n
        FROM ref_receita_estabelecimento e
        WHERE e.building_key = ${Buffer.from(buildingKey)}
          AND e.situacao_cadastral = 2
          AND e.data_abertura >= (CURRENT_DATE - INTERVAL '12 months')
      )
      SELECT
        (SELECT COUNT(*)::int FROM co_located) AS co_located_cnpjs,
        (SELECT COUNT(DISTINCT cp.cnpj_basico)::int FROM colocated_partners cp
           JOIN subject_partners sp ON sp.partner_key = cp.partner_key) AS cnpjs_sharing_partner,
        (SELECT n FROM recent_openings) AS recent_openings
    `)) as unknown as ReadonlyArray<Record<string, unknown>>
    const row = Array.isArray(result) ? result[0] : undefined
    const coLocated = Number(row?.['co_located_cnpjs'] ?? 0)
    return {
      coLocatedCnpjs: coLocated,
      cnpjsSharingPartner: Number(row?.['cnpjs_sharing_partner'] ?? 0),
      recentOpeningsAtAddress: Number(row?.['recent_openings'] ?? 0),
      hasData: coLocated > 0,
    }
  },
})
