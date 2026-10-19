import { normalizeLogradouro, normalizeNumero, normalizeText } from '@comprova/core'
import { CENSUS_YEAR, COLUMN, COMPLEMENTO_PAIRS, MIN_COLUMNS, UF_MAP, type CnefeRow } from './cnefe.schema.js'

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

/**
 * Parseia uma linha do CNEFE; devolve `null` (descartada) quando falta
 * identificador/UF/município válidos, quando a linha é curta demais ou quando
 * não há coordenada (o `0,0` do CNEFE significa "sem geometria").
 */
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

  // Sem coordenada (ou com `0,0`) a linha não serve à busca por raio — descartada.
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
