import { runMigrations } from '@comprova/db'
import { startTestDb, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import { rebuildEstablishmentKeys } from './rebuild-keys.service.js'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const sql = postgres(db.adminUrl, { max: 2 })

afterAll(async () => {
  await sql.end()
  await db.stop()
})

const insert = (basico: string, ordem: string, pais: number | null): Promise<unknown> =>
  sql`
    INSERT INTO ref_receita_estabelecimento
      (cnpj_basico, cnpj_ordem, cnpj_dv, matriz_filial, situacao_cadastral, snapshot_month,
       tipo_logradouro, logradouro, numero, complemento, bairro, cep, uf, pais_codigo)
    VALUES (${basico}, ${ordem}, '90', 1, 2, '2026-09-01',
       'R', 'Jose Paulino', '123', 'Apto 1', 'Centro', '01310100', 'SP', ${pais})
  `

describe('rebuildEstablishmentKeys (int)', () => {
  it('pagina pela identidade completa e limpa chaves de linhas inelegíveis', async () => {
    await insert('00000001', '0001', null)
    await insert('00000001', '0002', null)
    await insert('00000001', '0003', null)
    await insert('00000002', '0001', 999)
    // chave antiga numa linha que deixará de ser elegível: deve virar NULL
    await sql`UPDATE ref_receita_estabelecimento SET building_key = '\xdeadbeef'::bytea WHERE cnpj_basico = '00000002'`

    const processed = await rebuildEstablishmentKeys(sql, { batchSize: 2 })
    expect(processed).toBe(4)

    const rows = (await sql`
      SELECT cnpj_basico, cnpj_ordem, (building_key IS NULL) AS bnull, (unit_key IS NULL) AS unull
      FROM ref_receita_estabelecimento
      ORDER BY cnpj_basico, cnpj_ordem
    `) as unknown as ReadonlyArray<{
      cnpj_basico: string
      cnpj_ordem: string
      bnull: boolean
      unull: boolean
    }>

    expect(rows.map((r) => `${r.cnpj_basico}/${r.cnpj_ordem}`)).toEqual([
      '00000001/0001',
      '00000001/0002',
      '00000001/0003',
      '00000002/0001',
    ])
    expect(rows.map((r) => r.bnull)).toEqual([false, false, false, true])
    expect(rows.map((r) => r.unull)).toEqual([false, false, false, true])
  })
})
