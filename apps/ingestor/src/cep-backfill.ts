import { and, sql } from '@comprova/db'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import { makeBrasilApiCep } from '@comprova/providers'

export interface BackfillStats {
  readonly cepsProcessed: number
  readonly cepsFound: number
  readonly cepsNotFound: number
  readonly elapsedMs: number
}

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

  let found = 0
  let notFound = 0
  await missing.reduce<Promise<void>>(async (acc, row) => {
    await acc
    const record = await api.get(row.cep)
    if (record === null) {
      notFound++
      await db
        .insert(t.refCep)
        .values({ cep: row.cep, uf: '??', source: 'brasilapi-notfound' })
        .onConflictDoNothing()
      return
    }
    found++
    await db
      .insert(t.refCep)
      .values({
        cep: row.cep,
        uf: record.uf,
        municipioIbge: record.municipioIbge,
        localidade: record.localidade,
        bairro: record.bairro,
        logradouroNorm: record.logradouroNorm,
        source: 'brasilapi',
      })
      .onConflictDoNothing()
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
    }
  }, Promise.resolve())

  return {
    cepsProcessed: missing.length,
    cepsFound: found,
    cepsNotFound: notFound,
    elapsedMs: Date.now() - started,
  }
}

export const deriveMunicipioIbge = async (db: Db): Promise<number> => {
  const result = (await db.execute(sql`
    UPDATE ref_receita_estabelecimento e
    SET municipio_ibge = c.municipio_ibge
    FROM ref_cep c
    WHERE e.cep = c.cep
      AND c.municipio_ibge IS NOT NULL
      AND e.municipio_ibge IS NULL
    RETURNING e.cnpj_basico
  `)) as unknown as { rowCount?: number } | readonly unknown[]
  if (Array.isArray(result)) return result.length
  return Number((result as { rowCount?: number })?.rowCount ?? 0)
}

export const deriveMunicipioUf = async (db: Db): Promise<number> => {
  const result = (await db.execute(sql`
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
  `)) as unknown as { rowCount?: number } | readonly unknown[]
  if (Array.isArray(result)) return result.length
  return Number((result as { rowCount?: number })?.rowCount ?? 0)
}
