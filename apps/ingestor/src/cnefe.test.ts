import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Db } from '@comprova/db'
import { ingestCnefeCsv, parseCnefeLine } from './cnefe.js'

/**
 * Caracterização do parser/ingestor do CNEFE: protege a refatoração do layout
 * (índices de coluna, descartes e estatísticas) sem depender do banco real —
 * o `Db` aqui é um espião que registra os lotes gravados.
 */

const HEADER =
  'COD_UNICO_ENDERECO;NU_UF;CODIGO_MUNICIPIO;...;CEP;...;NM_TIPO_LOGRADOURO;...;LATITUDE;LONGITUDE;...;ESPECIE;...'

/** Linha de 34 colunas com o layout mínimo válido; overrides por índice. */
const line = (overrides: Readonly<Record<number, string>> = {}): string => {
  const cols = Array.from({ length: 34 }, () => '')
  cols[0] = '319876543210'
  cols[1] = '35'
  cols[2] = '3550308'
  cols[8] = '01310100'
  cols[10] = 'R'
  cols[12] = 'José Paulino'
  cols[13] = '123'
  cols[25] = '-23.55'
  cols[26] = '-46.6333'
  cols[28] = '8'
  for (const [index, value] of Object.entries(overrides)) {
    cols[Number(index)] = value
  }
  return cols.join(';')
}

const fakeDb = () => {
  const batches: number[][] = []
  const db = {
    insert: (_table: unknown) => ({
      values: (rows: ReadonlyArray<{ readonly cnefeId: number }>) => ({
        onConflictDoNothing: async () => {
          batches.push(rows.map((row) => row.cnefeId))
        },
      }),
    }),
  }
  return { db: db as unknown as Db, batches }
}

const dir = mkdtempSync(path.join(tmpdir(), 'cnefe-ingest-'))
const writeCsv = (name: string, lines: readonly string[]): string => {
  const file = path.join(dir, name)
  writeFileSync(file, lines.join('\n'), 'utf-8')
  return file
}
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('parseCnefeLine', () => {
  it('mapeia as colunas do layout CNEFE 2022', () => {
    expect(parseCnefeLine(line())).toEqual({
      cnefeId: 319_876_543_210,
      uf: 'SP',
      municipioIbge: 3_550_308,
      cep: '01310100',
      logradouroNorm: 'RUA JOSE PAULINO',
      numero: '123',
      complementoNorm: null,
      especie: 8,
      geom: 'SRID=4326;POINT(-46.6333 -23.55)',
      censusYear: 2022,
    })
  })

  it('usa o modificador quando a coluna do número vem vazia', () => {
    expect(parseCnefeLine(line({ 13: '', 14: 'S/N' }))?.numero).toBe('S/N')
    expect(parseCnefeLine(line({ 13: '', 14: '' }))?.numero).toBeNull()
  })

  it('junta os pares (tipo, valor) de complemento normalizados', () => {
    expect(parseCnefeLine(line({ 15: 'Apto', 16: '101', 19: 'BL', 20: 'B' }))?.complementoNorm).toBe(
      'APTO 101 BL B',
    )
  })

  it('descarta linhas sem identificador, UF desconhecida, linha curta ou sem geometria', () => {
    expect(parseCnefeLine(line({ 0: '' }))).toBeNull()
    expect(parseCnefeLine(line({ 1: '99' }))).toBeNull()
    expect(parseCnefeLine('a;b;c')).toBeNull()
    expect(parseCnefeLine(line({ 25: '0' }))).toBeNull()
    expect(parseCnefeLine(line({ 26: 'abc' }))).toBeNull()
  })

  it('CEP só vale com 8 dígitos; vazio vira null', () => {
    expect(parseCnefeLine(line({ 8: '' }))?.cep).toBeNull()
    expect(parseCnefeLine(line({ 8: '123' }))?.cep).toBeNull()
    expect(parseCnefeLine(line({ 8: '01310-100' }))?.cep).toBe('01310100')
  })

  it('especie vazia permanece null', () => {
    expect(parseCnefeLine(line({ 28: '' }))?.especie).toBeNull()
  })
})

describe('ingestCnefeCsv', () => {
  it('valida o cabeçalho, grava em lotes de batchSize e devolve estatísticas', async () => {
    const { db, batches } = fakeDb()
    const file = writeCsv('valido.csv', [HEADER, line({ 0: '111' }), line({ 0: '222' }), line({ 0: '333' })])

    const stats = await ingestCnefeCsv(db, file, { batchSize: 2 })

    expect(batches).toEqual([[111, 222], [333]])
    expect(stats).toMatchObject({ rows: 3, skipped: 0 })
    expect(stats.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('conta linhas inválidas como skipped sem interromper o fluxo', async () => {
    const { db, batches } = fakeDb()
    const file = writeCsv('com-invalidas.csv', [
      HEADER,
      line({ 0: '111' }),
      'linha;curta',
      line({ 0: '222' }),
      line({ 1: '99' }),
    ])

    const stats = await ingestCnefeCsv(db, file)

    expect(batches).toEqual([[111, 222]])
    expect(stats).toMatchObject({ rows: 2, skipped: 2 })
  })

  it('`limit` para após gravar N linhas ingeridas (não lidas)', async () => {
    const { db, batches } = fakeDb()
    const file = writeCsv('com-limit.csv', [
      HEADER,
      line({ 0: '111' }),
      line({ 0: '222' }),
      line({ 0: '333' }),
    ])

    const stats = await ingestCnefeCsv(db, file, { limit: 2 })

    expect(batches).toEqual([[111, 222]])
    expect(stats).toMatchObject({ rows: 2, skipped: 0 })
  })

  it('linhas em branco não contam como skipped', async () => {
    const { db, batches } = fakeDb()
    const file = writeCsv('com-brancas.csv', [HEADER, '', line({ 0: '111' }), '   '])

    const stats = await ingestCnefeCsv(db, file)

    expect(batches).toEqual([[111]])
    expect(stats).toMatchObject({ rows: 1, skipped: 0 })
  })

  it('recusa arquivo cuja 1ª linha não é o cabeçalho esperado', async () => {
    const { db, batches } = fakeDb()
    const file = writeCsv('sem-header.csv', [line({ 0: '111' }), line({ 0: '222' })])

    await expect(ingestCnefeCsv(db, file)).rejects.toThrow('CNEFE CSV missing expected header')
    expect(batches).toEqual([])
  })

  it('recusa arquivo vazio (nenhuma linha, nem cabeçalho)', async () => {
    const { db, batches } = fakeDb()
    const file = writeCsv('vazio.csv', [])

    await expect(ingestCnefeCsv(db, file)).rejects.toThrow('CNEFE CSV missing expected header')
    expect(batches).toEqual([])
  })
})
