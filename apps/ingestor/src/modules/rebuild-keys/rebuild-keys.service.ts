import { addressKeys, canonicalizeAddress } from '@comprova/core'
import type postgres from 'postgres'

/**
 * Reprocessa `building_key`/`unit_key` de todos os estabelecimentos, página a
 * página, por keyset da identidade completa (`(cnpj_basico, cnpj_ordem, cnpj_dv)`).
 * Antes era um script com `for(;;)` e acumuladores mutáveis; agora é recursivo e
 * puro, com a montagem dos patches separada da gravação.
 */

export interface EstabelecimentoKeyRow {
  readonly cnpj_basico: string
  readonly cnpj_ordem: string
  readonly cnpj_dv: string
  readonly tipo_logradouro: string | null
  readonly logradouro: string | null
  readonly numero: string | null
  readonly complemento: string | null
  readonly bairro: string | null
  readonly cep: string | null
  readonly uf: string | null
  readonly pais_codigo: number | null
}

export interface KeyPatch {
  readonly basico: string
  readonly ordem: string
  readonly dv: string
  /** Literal `\x…` para `bytea`, ou `''` (gravado como `NULL`) quando não há endereço. */
  readonly buildingKey: string
  readonly unitKey: string
}

export interface RebuildKeysProgress {
  readonly processed: number
  readonly elapsedMs: number
}

export interface RebuildKeysOptions {
  readonly batchSize?: number
  readonly onProgress?: (progress: RebuildKeysProgress) => void
}

const byteaLiteral = (bytes: Buffer): string => `\\x${bytes.toString('hex')}`

/** Chaves de uma linha; sem endereço nacional completo, ambas ficam vazias (gravadas como NULL). */
export const keysForRow = (row: EstabelecimentoKeyRow): KeyPatch => {
  const identity = { basico: row.cnpj_basico, ordem: row.cnpj_ordem, dv: row.cnpj_dv }
  const hasAddress =
    row.cep !== null && row.uf !== null && row.logradouro !== null && row.pais_codigo === null
  if (!hasAddress) return { ...identity, buildingKey: '', unitKey: '' }

  const keys = addressKeys(
    canonicalizeAddress({
      tipoLogradouro: row.tipo_logradouro,
      logradouro: row.logradouro,
      numero: row.numero,
      complemento: row.complemento,
      bairro: row.bairro,
      cep: row.cep,
      uf: row.uf,
      countryCode: 'BR',
    }),
  )
  return { ...identity, buildingKey: byteaLiteral(keys.buildingKey), unitKey: byteaLiteral(keys.unitKey) }
}

interface KeyCursor {
  readonly basico: string
  readonly ordem: string
  readonly dv: string
}

const fetchKeyPage = async (
  sql: postgres.Sql,
  after: KeyCursor | null,
  batchSize: number,
): Promise<readonly EstabelecimentoKeyRow[]> => {
  const rows = await (after === null
    ? sql`SELECT cnpj_basico, cnpj_ordem, cnpj_dv, tipo_logradouro, logradouro,
             numero, complemento, bairro, cep, uf, pais_codigo
          FROM ref_receita_estabelecimento
          ORDER BY cnpj_basico, cnpj_ordem, cnpj_dv
          LIMIT ${batchSize}`
    : sql`SELECT cnpj_basico, cnpj_ordem, cnpj_dv, tipo_logradouro, logradouro,
             numero, complemento, bairro, cep, uf, pais_codigo
          FROM ref_receita_estabelecimento
          WHERE (cnpj_basico, cnpj_ordem, cnpj_dv) > (${after.basico}, ${after.ordem}, ${after.dv})
          ORDER BY cnpj_basico, cnpj_ordem, cnpj_dv
          LIMIT ${batchSize}`)
  return rows as unknown as readonly EstabelecimentoKeyRow[]
}

const applyKeyPatches = async (sql: postgres.Sql, patches: readonly KeyPatch[]): Promise<void> => {
  if (patches.length === 0) return
  const column = (pick: (patch: KeyPatch) => string) => sql.array(patches.map(pick))
  await sql`
    UPDATE ref_receita_estabelecimento e
    SET building_key = NULLIF(t.bkey, ''::bytea), unit_key = NULLIF(t.ukey, ''::bytea)
    FROM unnest(
      ${column((patch) => patch.basico)}::text[],
      ${column((patch) => patch.ordem)}::text[],
      ${column((patch) => patch.dv)}::text[],
      ${column((patch) => patch.buildingKey)}::bytea[],
      ${column((patch) => patch.unitKey)}::bytea[]
    ) AS t(basico, ordem, dv, bkey, ukey)
    WHERE e.cnpj_basico = t.basico AND e.cnpj_ordem = t.ordem AND e.cnpj_dv = t.dv
  `
}

/** Percorre todas as páginas por keyset e devolve o total de linhas reprocessadas. */
export const rebuildEstablishmentKeys = async (
  sql: postgres.Sql,
  options: RebuildKeysOptions = {},
): Promise<number> => {
  const batchSize = options.batchSize ?? 20_000
  const started = Date.now()

  const step = async (processed: number, after: KeyCursor | null): Promise<number> => {
    const rows = await fetchKeyPage(sql, after, batchSize)
    if (rows.length === 0) return processed

    // Todas as linhas viram patch, inclusive as sem endereço: `NULLIF` grava NULL
    // e limpa chaves antigas de linhas que deixaram de ser elegíveis.
    await applyKeyPatches(sql, rows.map(keysForRow))

    const total = processed + rows.length
    options.onProgress?.({ processed: total, elapsedMs: Date.now() - started })

    const last = rows.at(-1)
    return last === undefined
      ? total
      : step(total, { basico: last.cnpj_basico, ordem: last.cnpj_ordem, dv: last.cnpj_dv })
  }

  return step(0, null)
}
