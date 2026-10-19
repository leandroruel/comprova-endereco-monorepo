import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { ingestLineStream } from '../../lib/stream.js'
import { parseCnefeLine } from './cnefe.parser.js'
import { HEADER_MARKER, type CnefeIngestStats, type CnefeRow } from './cnefe.schema.js'

/** Grava um lote; duplicatas (`cnefe_id` já presente) são ignoradas. */
const insertCnefeBatch = async (db: Db, rows: readonly CnefeRow[]): Promise<void> => {
  if (rows.length === 0) return
  // O `.values` do Drizzle pede array mutável; o lote é copiado na fronteira.
  await db
    .insert(t.refCnefeAddress)
    .values([...rows])
    .onConflictDoNothing()
}

/**
 * Consome o CSV do CNEFE linha a linha e grava em lotes de `batchSize`: a 1ª
 * linha é o cabeçalho (validada e descartada), as demais são parseadas — linhas
 * inválidas/sem geometria contam em `skipped` sem interromper o fluxo, e `limit`
 * para após gravar `limit` linhas válidas. O stream é fechado no `finally`.
 */
export const ingestCnefeCsv = async (
  db: Db,
  csvPath: string,
  options: { readonly batchSize?: number; readonly limit?: number } = {},
): Promise<CnefeIngestStats> => {
  const batchSize = options.batchSize ?? 2_000
  const started = Date.now()

  const rl = createInterface({
    input: createReadStream(csvPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })
  const lines = rl[Symbol.asyncIterator]()

  try {
    const header = await lines.next()
    if (header.done === true || !header.value.includes(HEADER_MARKER)) {
      throw new Error('CNEFE CSV missing expected header')
    }

    const stats = await ingestLineStream<CnefeRow>(lines, {
      batchSize,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      parse: parseCnefeLine,
      write: (batch) => insertCnefeBatch(db, batch),
    })

    return { rows: stats.ingested, skipped: stats.skipped, elapsedMs: Date.now() - started }
  } finally {
    rl.close()
  }
}
