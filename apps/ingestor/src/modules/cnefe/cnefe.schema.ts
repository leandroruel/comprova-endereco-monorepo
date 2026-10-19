/**
 * Layout fixo do CSV da malha de endereços do CNEFE (censo 2022, separado por
 * `;`): constantes, mapa de UF e o formato de uma linha parseada. Índices 0-based
 * do layout do IBGE — se o layout mudar, mudam aqui e o teste de caracterização
 * aponta.
 */

/** Colunas do CSV que o parser usa. */
export const COLUMN = {
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
export const COMPLEMENTO_PAIRS: ReadonlyArray<readonly [tipo: number, valor: number]> = [
  [15, 16],
  [17, 18],
  [19, 20],
  [21, 22],
  [23, 24],
]

/** Linhas com menos colunas que isso estão truncadas/corrompidas. */
export const MIN_COLUMNS = 34
export const CENSUS_YEAR = 2022

/** Marcador da primeira linha do CSV do CNEFE. */
export const HEADER_MARKER = 'COD_UNICO_ENDERECO'

/** Código numérico da UF (IBGE) → sigla. */
export const UF_MAP: Readonly<Record<string, string>> = {
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

export interface CnefeIngestStats {
  readonly rows: number
  readonly skipped: number
  readonly elapsedMs: number
}
