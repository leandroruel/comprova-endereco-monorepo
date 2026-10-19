import { normalizeLogradouro, normalizeNumero, normalizeText } from '@comprova/core'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

/**
 * Colunas do CSV da malha de endereços do CNEFE (censo 2022, separado por `;`)
 * que o parser usa. Índices 0-based do layout fixo do IBGE — se o layout
 * mudar, mudam aqui e o teste de caracterização aponta.
 */
const COLUMN = {
  /** Identificador único do endereço no CNEFE. */
  cnefeId: 0,
  /** Código numérico da UF (2 dígitos); a sigla vem de `UF_MAP`. */
  uf: 1,
  /** Código IBGE do município (7 dígitos). */
  municipio: 2,
  cep: 8,
  tipoLogradouro: 10,
  tituloLogradouro: 11,
  nomeLogradouro: 12,
  numero: 13,
  /** Modificador do endereço (ex.: `S/N`), usado quando a coluna do número vem vazia. */
  modificadorNumero: 14,
  latitude: 25,
  longitude: 26,
  /** Espécie do endereço; `null` quando a coluna vem vazia. */
  especie: 28,
} as const

/** Complemento ocupa 5 pares (tipo, valor) — colunas 15 a 24. */
const COMPLEMENTO_PAIRS: ReadonlyArray<readonly [tipo: number, valor: number]> = [
  [15, 16],
  [17, 18],
  [19, 20],
  [21, 22],
  [23, 24],
]

/** Linhas com menos colunas que isso estão truncadas/corrompidas. */
const MIN_COLUMNS = 34
const CENSUS_YEAR = 2022

/** Marcador da primeira linha do CSV do CNEFE. */
const HEADER_MARKER = 'COD_UNICO_ENDERECO'

/** Código numérico da UF (IBGE) → sigla. */
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

/** Coluna do CSV já aparada; colunas ausentes viram string vazia. */
const field = (columns: readonly string[], index: number): string => (columns[index] ?? '').trim()

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
  if (f.length < MIN_COLUMNS) return null

  const cnefeIdRaw = digits(field(f, COLUMN.cnefeId))
  if (cnefeIdRaw === null) return null
  const cnefeId = Number(cnefeIdRaw)
  if (!Number.isFinite(cnefeId)) return null

  const uf = UF_MAP[field(f, COLUMN.uf)]
  if (uf === undefined) return null

  const munRaw = digits(field(f, COLUMN.municipio))
  if (munRaw === null || munRaw.length !== 7) return null
  const municipioIbge = Number(munRaw)

  const cepRaw = digits(field(f, COLUMN.cep))
  const cep = cepRaw !== null && cepRaw.length === 8 ? cepRaw : null

  const logradouroNorm = normalizeLogradouro(
    `${field(f, COLUMN.tipoLogradouro)} ${field(f, COLUMN.tituloLogradouro)}`.trim(),
    field(f, COLUMN.nomeLogradouro),
  )

  // Sem número na coluna própria, o modificador carrega a referência (`S/N`, lote…).
  const numeroRaw = field(f, COLUMN.numero)
  const modificador = field(f, COLUMN.modificadorNumero)
  const numero =
    numeroRaw !== '' ? normalizeNumero(numeroRaw) : modificador !== '' ? normalizeNumero(modificador) : null

  const complementoNorm = compOf(COMPLEMENTO_PAIRS.map(([tipo, valor]) => [field(f, tipo), field(f, valor)]))

  // Sem coordenada (ou com `0,0`, que o CNEFE usa como "sem geometria") a linha
  // não serve à busca por raio — descartada.
  const latNum = Number(field(f, COLUMN.latitude))
  const lonNum = Number(field(f, COLUMN.longitude))
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum) || latNum === 0 || lonNum === 0) {
    return null
  }
  const geom = `SRID=4326;POINT(${lonNum} ${latNum})`

  const especieRaw = digits(field(f, COLUMN.especie))
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
    censusYear: CENSUS_YEAR,
  }
}

export interface CnefeIngestStats {
  readonly rows: number
  readonly skipped: number
  readonly elapsedMs: number
}

/**
 * Consome o CSV do CNEFE linha a linha e grava em lotes de `batchSize`:
 * a 1ª linha é o cabeçalho (validada e descartada), as demais são parseadas —
 * linhas inválidas/sem geometria são contadas em `skipped` sem interromper o
 * fluxo, e `limit` para após gravar `limit` linhas válidas. O `for await`
 * fecha o stream ao terminar, inclusive quando o loop é interrompido.
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

  /** Grava um lote; duplicatas (`cnefe_id` já presente) são ignoradas. */
  const insertBatch = async (rows: readonly CnefeRow[]): Promise<void> => {
    if (rows.length === 0) return
    // O `.values` do Drizzle pede array mutável; o lote é copiado na fronteira.
    await db
      .insert(t.refCnefeAddress)
      .values([...rows])
      .onConflictDoNothing()
  }

  let ingested = 0
  let skipped = 0
  let pending: CnefeRow[] = []
  let isFirstLine = true

  for await (const line of rl) {
    if (isFirstLine) {
      isFirstLine = false
      if (!line.includes(HEADER_MARKER)) {
        throw new Error('CNEFE CSV missing expected header')
      }
      continue
    }

    if (line.trim().length === 0) continue

    const row = parseCnefeLine(line)
    if (row === null) {
      skipped++
      continue
    }

    pending.push(row)
    ingested++
    if (pending.length >= batchSize) {
      await insertBatch(pending)
      pending = []
    }
    // `limit` conta linhas ingeridas (não lidas): para depois de gravá-las.
    if (options.limit !== undefined && ingested >= options.limit) break
  }
  if (isFirstLine) {
    // Nem o cabeçalho chegou: arquivo vazio.
    throw new Error('CNEFE CSV missing expected header')
  }

  await insertBatch(pending)

  return { rows: ingested, skipped, elapsedMs: Date.now() - started }
}
