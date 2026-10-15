import { normalizeLogradouro, normalizeNumero, normalizeText } from '@comprova/core'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const UF_MAP: Readonly<Record<string, string>> = {
  '11': 'RO',
  '12': 'AC',
  '13': 'AM',
  '14': 'RR',
  '15': 'PA',
  '16': 'AP',
  '17': 'TO',
  '21': 'MA',
  '22': 'PI',
  '23': 'CE',
  '24': 'RN',
  '25': 'PB',
  '26': 'PE',
  '27': 'AL',
  '28': 'SE',
  '29': 'BA',
  '31': 'MG',
  '32': 'ES',
  '33': 'RJ',
  '35': 'SP',
  '41': 'PR',
  '42': 'SC',
  '43': 'RS',
  '50': 'MS',
  '51': 'MT',
  '52': 'GO',
  '53': 'DF',
}

const digits = (raw: string): string | null => {
  const d = raw.replace(/\D+/g, '')
  return d.length > 0 ? d : null
}

const compOf = (pairs: ReadonlyArray<readonly [string, string]>): string | null => {
  const parts = pairs.map(([name, val]) => `${name} ${val}`.trim()).filter((p) => p.length > 0)
  return parts.length > 0 ? normalizeText(parts.join(' ')) : null
}

export interface CnefeRow {
  readonly cnefeId: number
  readonly uf: string
  readonly municipioIbge: number
  readonly cep: string | null
  readonly logradouroNorm: string
  readonly numero: string | null
  readonly complementoNorm: string | null
  readonly especie: number | null
  readonly geom: string
  readonly censusYear: number
}

export const parseCnefeLine = (line: string): CnefeRow | null => {
  const f = line.split(';')
  if (f.length < 34) return null

  const cnefeIdRaw = digits(f[0] ?? '')
  if (cnefeIdRaw === null) return null
  const cnefeId = Number(cnefeIdRaw)
  if (!Number.isFinite(cnefeId)) return null

  const ufCode = f[1]?.trim() ?? ''
  const uf = UF_MAP[ufCode]
  if (uf === undefined) return null

  const munRaw = digits(f[2] ?? '')
  if (munRaw === null || munRaw.length !== 7) return null
  const municipioIbge = Number(munRaw)

  const cepRaw = digits(f[8] ?? '')
  const cep = cepRaw !== null && cepRaw.length === 8 ? cepRaw : null

  const tipoLogr = (f[10] ?? '').trim()
  const tituloLogr = (f[11] ?? '').trim()
  const nomeLogr = (f[12] ?? '').trim()
  const logradouroNorm = normalizeLogradouro(`${tipoLogr} ${tituloLogr}`.trim(), nomeLogr)

  const numEndereco = (f[13] ?? '').trim()
  const modificador = (f[14] ?? '').trim()
  const numero =
    numEndereco.length > 0
      ? normalizeNumero(numEndereco)
      : modificador.length > 0
        ? normalizeNumero(modificador)
        : null

  const complementoNorm = compOf([
    [(f[15] ?? '').trim(), (f[16] ?? '').trim()],
    [(f[17] ?? '').trim(), (f[18] ?? '').trim()],
    [(f[19] ?? '').trim(), (f[20] ?? '').trim()],
    [(f[21] ?? '').trim(), (f[22] ?? '').trim()],
    [(f[23] ?? '').trim(), (f[24] ?? '').trim()],
  ])

  const lat = (f[25] ?? '').trim()
  const lon = (f[26] ?? '').trim()
  const latNum = Number(lat)
  const lonNum = Number(lon)
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum) || latNum === 0 || lonNum === 0) {
    return null
  }
  const geom = `SRID=4326;POINT(${lonNum} ${latNum})`

  const especieRaw = digits(f[28] ?? '')
  const especie = especieRaw !== null ? Number(especieRaw) : null

  return {
    cnefeId,
    uf,
    municipioIbge,
    cep,
    logradouroNorm,
    numero,
    complementoNorm,
    especie,
    geom,
    censusYear: 2022,
  }
}

export interface CnefeIngestStats {
  readonly rows: number
  readonly skipped: number
  readonly elapsedMs: number
}

export const ingestCnefeCsv = async (
  db: Db,
  csvPath: string,
  options: { readonly batchSize?: number; readonly limit?: number } = {},
): Promise<CnefeIngestStats> => {
  const batchSize = options.batchSize ?? 2_000
  const started = Date.now()

  const stream = createReadStream(csvPath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  const lines = rl[Symbol.asyncIterator]()

  const header = await lines.next()
  if (header.done === true || !String(header.value).includes('COD_UNICO_ENDERECO')) {
    throw new Error('CNEFE CSV missing expected header')
  }

  let count = 0
  let skipped = 0
  let batch: (CnefeRow & { readonly geomSql: string })[] = []

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    await db
      .insert(t.refCnefeAddress)
      .values(
        batch.map((row) => ({
          cnefeId: row.cnefeId,
          uf: row.uf,
          municipioIbge: row.municipioIbge,
          cep: row.cep,
          logradouroNorm: row.logradouroNorm,
          numero: row.numero,
          complementoNorm: row.complementoNorm,
          especie: row.especie,
          geom: row.geomSql,
          censusYear: row.censusYear,
        })),
      )
      .onConflictDoNothing()
    batch = []
  }

  for (;;) {
    const next = await lines.next()
    if (next.done === true) break
    const line = next.value
    if (line.trim().length === 0) continue

    const row = parseCnefeLine(line)
    if (row === null) {
      skipped++
      continue
    }

    batch.push({ ...row, geomSql: row.geom })
    if (batch.length >= batchSize) {
      await flush()
    }
    count++
    if (options.limit !== undefined && count >= options.limit) break
  }
  await flush()
  await lines.return?.()

  return { rows: count, skipped, elapsedMs: Date.now() - started }
}
