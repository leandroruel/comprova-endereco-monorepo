import { createHash } from 'node:crypto'

export const stripDiacritics = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')

const sha256 = (payload: string): Buffer => createHash('sha256').update(payload).digest()

export const normalizeText = (s: string): string =>
  stripDiacritics(s).toUpperCase().replace(/\s+/g, ' ').trim()

const TIPO_MAP: Readonly<Record<string, string>> = {
  R: 'RUA',
  RUA: 'RUA',
  AV: 'AVENIDA',
  AVEN: 'AVENIDA',
  AVENIDA: 'AVENIDA',
  TV: 'TRAVESSA',
  TRAV: 'TRAVESSA',
  TRAVESSA: 'TRAVESSA',
  JD: 'JARDIM',
  JARD: 'JARDIM',
  JARDIM: 'JARDIM',
  PCA: 'PRACA',
  PRACA: 'PRACA',
  EST: 'ESTRADA',
  ESTR: 'ESTRADA',
  ESTRADA: 'ESTRADA',
  AL: 'ALAMEDA',
  ALAM: 'ALAMEDA',
  ALAMEDA: 'ALAMEDA',
  BC: 'BECO',
  BECO: 'BECO',
  ROD: 'RODOVIA',
  RODOVIA: 'RODOVIA',
  FZ: 'FAZENDA',
  FAZENDA: 'FAZENDA',
  SIT: 'SITIO',
  SITIO: 'SITIO',
  CH: 'CHACARA',
  CHAC: 'CHACARA',
  CHACARA: 'CHACARA',
  VL: 'VILA',
  VILA: 'VILA',
  MR: 'MORRO',
  MORRO: 'MORRO',
  LGO: 'LARGO',
  LARGO: 'LARGO',
  DR: 'DOUTOR',
  DOUTOR: 'DOUTOR',
  PROF: 'PROFESSOR',
  PROFESSOR: 'PROFESSOR',
  CEL: 'CORONEL',
  CORONEL: 'CORONEL',
  STA: 'SANTA',
  SANTA: 'SANTA',
  STO: 'SANTO',
  SANTO: 'SANTO',
  SEN: 'SENADOR',
  SENADOR: 'SENADOR',
  DEP: 'DEPUTADO',
  DEPUTADO: 'DEPUTADO',
  GOV: 'GOVERNADOR',
  GOVERNADOR: 'GOVERNADOR',
  ENG: 'ENGENHEIRO',
  ENGENHEIRO: 'ENGENHEIRO',
  VER: 'VEREADOR',
  VEREADOR: 'VEREADOR',
  MAJ: 'MAJOR',
  MAJOR: 'MAJOR',
  GEN: 'GENERAL',
  GENERAL: 'GENERAL',
  PTE: 'PRESIDENTE',
  PRESIDENTE: 'PRESIDENTE',
}

const expandTipo = (token: string): string => {
  const bare = token.replace(/[.]+$/, '')
  return TIPO_MAP[bare] ?? token
}

export const normalizeLogradouro = (
  tipoLogradouro: string | null | undefined,
  logradouro: string | null | undefined,
): string => {
  const joined = normalizeText(`${tipoLogradouro ?? ''} ${logradouro ?? ''}`)
  return joined
    .split(' ')
    .filter((t) => t.length > 0)
    .map((t) => expandTipo(t))
    .filter((t) => t.length > 0)
    .join(' ')
    .trim()
}

const SEM_NUMERO_RE = /^(S\s*[/.,-]?\s*N[Oº.]?|SEM\s+NUMERO?|S\/N?O?)$/

interface ExtractedComponent {
  readonly canonical: string
  readonly rest: string
}

const extractComponent =
  (re: RegExp, label: string) =>
  (text: string): ExtractedComponent => {
    const match = text.match(re)
    if (match === null || match[1] === undefined) return { canonical: '', rest: text }
    return {
      canonical: `${label} ${match[1]}`,
      rest: text.replace(match[0], ' ').replace(/\s+/g, ' ').trim(),
    }
  }

const extractKm = extractComponent(/KM\s*([\d]+(?:,[\d]+)?)/, 'KM')
const extractQuadra = extractComponent(/(?:QUADRA|QD|QL)\s*([\w-]+)/, 'QD')
const extractLote = extractComponent(/(?:LOTE|LT)\s*([\w-]+)/, 'LT')

const cleanRemainderOnce = (s: string): string =>
  s
    .replace(/[.;,]+$/, '')
    .replace(/^#\s*/, '')
    .replace(/^N[ºO.]?\s+/, '')
    .replace(/^#\s*/, '')

const cleanRemainder = (s: string): string => {
  const trimmed = s.trim()
  const once = cleanRemainderOnce(trimmed)
  return once === trimmed ? trimmed : cleanRemainder(once)
}

export const normalizeNumero = (raw: string | null | undefined): string => {
  const t = normalizeText(raw ?? '')
  if (t.length === 0) return ''
  if (SEM_NUMERO_RE.test(t.replace(/\s+/g, ' '))) return 'S/N'
  const km = extractKm(t)
  const qd = extractQuadra(km.rest)
  const lt = extractLote(qd.rest)
  const remainder = cleanRemainder(lt.rest)
  const normalizedRemainder = remainder
    .replace(/(\d+)([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  return [km.canonical, qd.canonical, lt.canonical, normalizedRemainder]
    .filter((part) => part.length > 0)
    .join(' ')
    .trim()
}

export const normalizeCep = (raw: string | null | undefined): string =>
  (raw ?? '').replace(/\D+/g, '').slice(0, 8)

export const normalizeUf = (raw: string | null | undefined): string => normalizeText(raw ?? '').slice(0, 2)

export interface AddressComponents {
  readonly tipoLogradouro?: string | null
  readonly logradouro?: string | null
  readonly numero?: string | null
  readonly complemento?: string | null
  readonly bairro?: string | null
  readonly cep?: string | null
  readonly uf?: string | null
  readonly municipio?: string | null
  readonly municipioIbge?: number | null
  readonly countryCode?: string | null
}

export interface CanonicalAddress {
  readonly keyVersion: 1
  readonly countryCode: string
  readonly uf: string | null
  readonly municipioIbge: number | null
  readonly municipioNorm: string | null
  readonly logradouroNorm: string
  readonly numeroNorm: string
  readonly complementoNorm: string | null
  readonly bairroNorm: string | null
  readonly cep: string | null
  readonly isExterior: boolean
}

export const canonicalizeAddress = (input: AddressComponents): CanonicalAddress => {
  const countryCode = (input.countryCode ?? 'BR').toUpperCase()
  const logradouroNorm = normalizeLogradouro(input.tipoLogradouro, input.logradouro)
  return {
    keyVersion: 1,
    countryCode,
    uf: input.uf !== undefined && input.uf !== null && input.uf !== '' ? normalizeUf(input.uf) : null,
    municipioIbge: input.municipioIbge ?? null,
    municipioNorm:
      input.municipio !== undefined && input.municipio !== null && input.municipio !== ''
        ? normalizeText(input.municipio)
        : null,
    logradouroNorm,
    numeroNorm: normalizeNumero(input.numero),
    complementoNorm:
      input.complemento !== undefined && input.complemento !== null && input.complemento.trim() !== ''
        ? normalizeText(input.complemento)
        : null,
    bairroNorm:
      input.bairro !== undefined && input.bairro !== null && input.bairro.trim() !== ''
        ? normalizeText(input.bairro)
        : null,
    cep: input.cep !== undefined && input.cep !== null && input.cep !== '' ? normalizeCep(input.cep) : null,
    isExterior: countryCode !== 'BR',
  }
}

const KEY_VERSION = '1'

const keyPayload = (parts: readonly string[]): string => [KEY_VERSION, ...parts].join('|')

export interface AddressKeys {
  readonly buildingKey: Buffer
  readonly unitKey: Buffer
}

export const addressKeys = (canonical: CanonicalAddress): AddressKeys => ({
  buildingKey: buildingKeyOf(canonical),
  unitKey: unitKeyOf(canonical),
})

const buildingKeyOf = (canonical: CanonicalAddress): Buffer =>
  sha256(
    keyPayload([
      canonical.countryCode,
      canonical.uf ?? '',
      String(canonical.municipioIbge ?? canonical.municipioNorm ?? ''),
      canonical.logradouroNorm,
      canonical.numeroNorm,
    ]),
  )

const unitKeyOf = (canonical: CanonicalAddress): Buffer =>
  sha256(`${buildingKeyOf(canonical).toString('hex')}|${canonical.complementoNorm ?? ''}`)
