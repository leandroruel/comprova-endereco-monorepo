import { sql } from '@comprova/db'
import type { Db } from '@comprova/db'
import type { EstabelecimentoInsertRow } from './receita.parser.js'

export interface UpsertWithHistoryResult {
  readonly upserted: number
  readonly historyInserted: number
}

type SqlValue = string | number | null | undefined | Uint8Array | readonly string[]

/** Literal SQL de um valor do lote (o `VALUES` é montado sem placeholders). */
const renderValue = (value: SqlValue): string => {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (value instanceof Uint8Array) return `'\\x${Buffer.from(value).toString('hex')}'`
  if (Array.isArray(value)) return `ARRAY[${value.map((code) => `'${code}'`).join(',')}]::char(7)[]`
  return `'${String(value).replace(/'/g, "''")}'`
}

const renderRow = (row: EstabelecimentoInsertRow): string => {
  const values: readonly SqlValue[] = [
    row.cnpjBasico,
    row.cnpjOrdem,
    row.cnpjDv,
    row.matrizFilial,
    row.nomeFantasia,
    row.situacaoCadastral,
    row.dataSituacao,
    row.motivoSituacao,
    row.dataAbertura,
    row.cnaePrincipal,
    row.cnaesSecundarios,
    row.tipoLogradouro,
    row.logradouro,
    row.numero,
    row.complemento,
    row.bairro,
    row.cep,
    row.uf,
    row.municipioReceita,
    row.municipioIbge,
    row.paisCodigo,
    row.cidadeExterior,
    row.telefone,
    row.emailDomain,
    row.buildingKey,
    row.unitKey,
  ]
  return `(${values.map(renderValue).join(',')})`
}

/**
 * Insere/atualiza estabelecimentos em lote e registra no histórico os que
 * mudaram. O `VALUES` é montado linha a linha e passado como `sql.raw` porque o
 * volume do lote e a lista de colunas não cabem no builder; o histórico é
 * gravado numa única CTE, antes do upsert.
 */
export const upsertEstabelecimentosWithHistory = async (
  db: Db,
  batch: readonly EstabelecimentoInsertRow[],
  snapshotMonth: string,
): Promise<UpsertWithHistoryResult> => {
  if (batch.length === 0) return { upserted: 0, historyInserted: 0 }

  const values = batch.map(renderRow).join(',')

  const result = (await db.execute(
    sql.raw(`
    WITH new_data AS (
      SELECT * FROM (VALUES ${values}) AS t(
        cnpj_basico, cnpj_ordem, cnpj_dv, matriz_filial, nome_fantasia,
        situacao_cadastral, data_situacao, motivo_situacao, data_abertura,
        cnae_principal, cnaes_secundarios, tipo_logradouro, logradouro,
        numero, complemento, bairro, cep, uf,
        municipio_receita, municipio_ibge, pais_codigo, cidade_exterior,
        telefone, email_domain, building_key, unit_key
      )
    ),
    changed AS (
      SELECT n.*,
        EXISTS (
          SELECT 1 FROM ref_receita_estabelecimento e
          WHERE e.cnpj_basico = n.cnpj_basico
            AND e.cnpj_ordem = n.cnpj_ordem
            AND e.cnpj_dv = n.cnpj_dv
            AND (
              e.logradouro IS DISTINCT FROM n.logradouro
              OR e.numero IS DISTINCT FROM n.numero
              OR e.complemento IS DISTINCT FROM n.complemento
              OR e.bairro IS DISTINCT FROM n.bairro
              OR e.cep IS DISTINCT FROM n.cep
              OR e.uf IS DISTINCT FROM n.uf
              OR e.municipio_receita IS DISTINCT FROM n.municipio_receita
              OR e.situacao_cadastral IS DISTINCT FROM n.situacao_cadastral
              OR e.nome_fantasia IS DISTINCT FROM n.nome_fantasia
              OR e.cnae_principal IS DISTINCT FROM n.cnae_principal
            )
        ) AS has_changed
      FROM new_data n
    ),
    history_rows AS (
      INSERT INTO ref_estabelecimento_history (
        cnpj_basico, cnpj_ordem, cnpj_dv, matriz_filial, nome_fantasia,
        situacao_cadastral, data_situacao, motivo_situacao, data_abertura,
        cnae_principal, cnaes_secundarios, tipo_logradouro, logradouro,
        numero, complemento, bairro, cep, uf,
        municipio_receita, municipio_ibge, pais_codigo, cidade_exterior,
        telefone, email_domain, building_key, unit_key,
        snapshot_month, valid_from, valid_to
      )
      SELECT e.cnpj_basico, e.cnpj_ordem, e.cnpj_dv, e.matriz_filial, e.nome_fantasia,
        e.situacao_cadastral, e.data_situacao, e.motivo_situacao, e.data_abertura,
        e.cnae_principal, e.cnaes_secundarios, e.tipo_logradouro, e.logradouro,
        e.numero, e.complemento, e.bairro, e.cep, e.uf,
        e.municipio_receita, e.municipio_ibge, e.pais_codigo, e.cidade_exterior,
        e.telefone, e.email_domain, e.building_key, e.unit_key,
        e.snapshot_month, e.snapshot_month, '${snapshotMonth}'
      FROM ref_receita_estabelecimento e
      JOIN changed c ON e.cnpj_basico = c.cnpj_basico
        AND e.cnpj_ordem = c.cnpj_ordem
        AND e.cnpj_dv = c.cnpj_dv
      WHERE c.has_changed = true
      RETURNING 1
    )
    INSERT INTO ref_receita_estabelecimento AS e (
      cnpj_basico, cnpj_ordem, cnpj_dv, matriz_filial, nome_fantasia,
      situacao_cadastral, data_situacao, motivo_situacao, data_abertura,
      cnae_principal, cnaes_secundarios, tipo_logradouro, logradouro,
      numero, complemento, bairro, cep, uf,
      municipio_receita, municipio_ibge, pais_codigo, cidade_exterior,
      telefone, email_domain, building_key, unit_key, snapshot_month
    )
    SELECT n.cnpj_basico, n.cnpj_ordem, n.cnpj_dv, n.matriz_filial, n.nome_fantasia,
      n.situacao_cadastral, n.data_situacao, n.motivo_situacao, n.data_abertura,
      n.cnae_principal, n.cnaes_secundarios, n.tipo_logradouro, n.logradouro,
      n.numero, n.complemento, n.bairro, n.cep, n.uf,
      n.municipio_receita, n.municipio_ibge, n.pais_codigo, n.cidade_exterior,
      n.telefone, n.email_domain, n.building_key, n.unit_key, '${snapshotMonth}'
    FROM new_data n
    ON CONFLICT (cnpj_basico, cnpj_ordem, cnpj_dv) DO UPDATE SET
      matriz_filial = EXCLUDED.matriz_filial,
      nome_fantasia = EXCLUDED.nome_fantasia,
      situacao_cadastral = EXCLUDED.situacao_cadastral,
      data_situacao = EXCLUDED.data_situacao,
      motivo_situacao = EXCLUDED.motivo_situacao,
      data_abertura = EXCLUDED.data_abertura,
      cnae_principal = EXCLUDED.cnae_principal,
      cnaes_secundarios = EXCLUDED.cnaes_secundarios,
      tipo_logradouro = EXCLUDED.tipo_logradouro,
      logradouro = EXCLUDED.logradouro,
      numero = EXCLUDED.numero,
      complemento = EXCLUDED.complemento,
      bairro = EXCLUDED.bairro,
      cep = EXCLUDED.cep,
      uf = EXCLUDED.uf,
      municipio_receita = EXCLUDED.municipio_receita,
      municipio_ibge = EXCLUDED.municipio_ibge,
      pais_codigo = EXCLUDED.pais_codigo,
      cidade_exterior = EXCLUDED.cidade_exterior,
      telefone = EXCLUDED.telefone,
      email_domain = EXCLUDED.email_domain,
      building_key = EXCLUDED.building_key,
      unit_key = EXCLUDED.unit_key,
      snapshot_month = EXCLUDED.snapshot_month
    RETURNING (xmax = 0) AS is_insert
  `),
  )) as unknown as readonly { is_insert: boolean }[]

  return {
    upserted: result.length,
    historyInserted: result.filter((row) => !row.is_insert).length,
  }
}
