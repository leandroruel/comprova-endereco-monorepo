import { and, sql } from '@comprova/db'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import { mapSequential } from '@comprova/core'
import { makeBrasilApiCep } from '@comprova/providers'
import { rowCountOf } from '../../lib/db-result.js'

export interface BackfillStats {
  readonly cepsProcessed: number
  readonly cepsFound: number
  readonly cepsNotFound: number
  readonly elapsedMs: number
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Consulta na BrasilAPI os CEPs de estabelecimentos que ainda não estão em
 * `ref_cep`, grava cada resultado e conta achados/perdidos. Processa em série
 * (`mapSequential`) com uma pausa entre chamadas para não estourar o provedor.
 */
export const backfillCepsFromEstabelecimentos = async (
  db: Db,
  options: { readonly limit?: number; readonly batchSize?: number; readonly sleepMs?: number } = {},
): Promise<BackfillStats> => {
  const limit = options.limit ?? 500
  const sleepMs = options.sleepMs ?? 400
  const api = makeBrasilApiCep()
  const started = Date.now()

  const missing = (await db
    .selectDistinct({ cep: t.refReceitaEstabelecimento.cep })
    .from(t.refReceitaEstabelecimento)
    .where(
      and(
        sql`${t.refReceitaEstabelecimento.cep} IS NOT NULL`,
        sql`${t.refReceitaEstabelecimento.cep} NOT IN (SELECT cep FROM ref_cep)`,
      ),
    )
    .limit(limit)) as readonly { readonly cep: string }[]

  const results = await mapSequential(missing, async (row) => {
    const record = await api.get(row.cep)
    const insert =
      record === null
        ? db.insert(t.refCep).values({ cep: row.cep, uf: '??', source: 'brasilapi-notfound' })
        : db.insert(t.refCep).values({
            cep: row.cep,
            uf: record.uf,
            municipioIbge: record.municipioIbge,
            localidade: record.localidade,
            bairro: record.bairro,
            logradouroNorm: record.logradouroNorm,
            source: 'brasilapi',
          })
    await insert.onConflictDoNothing()
    // A pausa vale para achados e não-achados: o que precisa ser contido é a taxa
    // de chamadas ao provedor, não só as respostas com sucesso.
    if (sleepMs > 0) await sleep(sleepMs)
    return record !== null
  })

  const cepsFound = results.filter((found) => found).length
  return {
    cepsProcessed: missing.length,
    cepsFound,
    cepsNotFound: results.length - cepsFound,
    elapsedMs: Date.now() - started,
  }
}

export const deriveMunicipioIbge = async (db: Db): Promise<number> => {
  const result = await db.execute(sql`
    UPDATE ref_receita_estabelecimento e
    SET municipio_ibge = c.municipio_ibge
    FROM ref_cep c
    WHERE e.cep = c.cep
      AND c.municipio_ibge IS NOT NULL
      AND e.municipio_ibge IS NULL
    RETURNING e.cnpj_basico
  `)
  return rowCountOf(result)
}

export const deriveMunicipioUf = async (db: Db): Promise<number> => {
  const result = await db.execute(sql`
    UPDATE ref_receita_municipio m
    SET uf = sub.uf
    FROM (
      SELECT DISTINCT municipio_receita, uf
      FROM ref_receita_estabelecimento
      WHERE municipio_receita IS NOT NULL AND uf IS NOT NULL
    ) sub
    WHERE m.codigo_receita = sub.municipio_receita
      AND m.uf IS NULL
    RETURNING m.codigo_receita
  `)
  return rowCountOf(result)
}
