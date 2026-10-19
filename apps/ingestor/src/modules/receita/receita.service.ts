import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { collectAsync, ingestLineStream } from '../../lib/stream.js'
import {
  parseLine,
  parseMunicipioLine,
  toEstabelecimentoValues,
  toInsertRow,
  type EstabelecimentoInsertRow,
  type ReceitaMunicipioRow,
} from './receita.parser.js'
import type { IngestStats } from './receita.schema.js'
import { upsertEstabelecimentosWithHistory } from './receita.upsert.js'

const openCsv = (csvPath: string) =>
  createInterface({ input: createReadStream(csvPath, { encoding: 'latin1' }), crlfDelay: Infinity })

/** Parser de estabelecimento com o mês do snapshot fixado no lote. */
const estabelecimentoParser =
  (snapshotMonth: string) =>
  (line: string): EstabelecimentoInsertRow | null => {
    const values = toEstabelecimentoValues(parseLine(line), snapshotMonth)
    return values === null ? null : toInsertRow(values)
  }

export const ingestReceitaEstabelecimentos = async (
  db: Db,
  csvPath: string,
  snapshotMonth: string,
  options: { readonly limit?: number; readonly batchSize?: number } = {},
): Promise<IngestStats> => {
  const batchSize = options.batchSize ?? 2_000
  const started = Date.now()

  const rl = openCsv(csvPath)
  try {
    const stats = await ingestLineStream<EstabelecimentoInsertRow>(rl[Symbol.asyncIterator](), {
      batchSize,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      parse: estabelecimentoParser(snapshotMonth),
      write: async (batch) => {
        await upsertEstabelecimentosWithHistory(db, batch, snapshotMonth)
      },
    })
    return { rows: stats.ingested, snapshotMonth, elapsedMs: Date.now() - started }
  } finally {
    rl.close()
  }
}

export const ingestReceitaMunicipios = async (db: Db, csvPath: string): Promise<number> => {
  const rl = openCsv(csvPath)
  try {
    const rows = (await collectAsync(rl[Symbol.asyncIterator]()))
      .map(parseMunicipioLine)
      .filter((row): row is ReceitaMunicipioRow => row !== null)

    if (rows.length > 0) {
      await db
        .insert(t.refReceitaMunicipio)
        .values(rows.map((row) => ({ codigoReceita: row.codigoReceita, nomeNorm: row.nomeNorm })))
        .onConflictDoNothing()
    }
    return rows.length
  } finally {
    rl.close()
  }
}
