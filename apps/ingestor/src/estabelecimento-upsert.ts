import { sql } from '@comprova/db'
import type { Db } from '@comprova/db'

export interface UpsertWithHistoryResult {
  readonly upserted: number
  readonly historyInserted: number
}

export const upsertEstabelecimentosWithHistory = async (
  db: Db,
  batch: ReadonlyArray<Record<string, unknown>>,
  snapshotMonth: string,
): Promise<UpsertWithHistoryResult> => {
  if (batch.length === 0) return { upserted: 0, historyInserted: 0 }

  const values = batch
    .map((row) => {
      const b = row as Record<string, string | number | null | Uint8Array | readonly string[] | undefined>
      const vals = [
        b['cnpjBasico'],
        b['cnpjOrdem'],
        b['cnpjDv'],
        b['matrizFilial'],
        b['nomeFantasia'],
        b['situacaoCadastral'],
        b['dataSituacao'],
        b['motivoSituacao'],
        b['dataAbertura'],
        b['cnaePrincipal'],
        b['cnaesSecundarios'],
        b['tipoLogradouro'],
        b['logradouro'],
        b['numero'],
        b['complemento'],
        b['bairro'],
        b['cep'],
        b['uf'],
        b['municipioReceita'],
        b['municipioIbge'],
        b['paisCodigo'],
        b['cidadeExterior'],
        b['telefone'],
        b['emailDomain'],
        b['buildingKey'],
        b['unitKey'],
      ]
      return `(${vals
        .map((v) => {
          if (v === null || v === undefined) return 'NULL'
          if (typeof v === 'number') return String(v)
          if (v instanceof Uint8Array) return `'\\x${Buffer.from(v).toString('hex')}'`
          if (Array.isArray(v)) return `ARRAY[${v.map((x) => `'${x}'`).join(',')}]::char(7)[]`
          return `'${String(v).replace(/'/g, "''")}'`
        })
        .join(',')})`
    })
    .join(',')

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
    historyInserted: result.filter((r) => !r.is_insert).length,
  }
}
