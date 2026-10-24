import {
  FISCAL_REFERENCE_CONTRACT_VERSION,
  fiscalReferenceFingerprint,
  type FiscalReference,
  type FiscalReferenceExtractionInput,
  type FiscalReferenceMethod,
  type FiscalReferenceReason,
  type FiscalSourceId,
} from '@comprova/core'
import { isSafeExternalUrl } from '../safe-fetch.js'

/**
 * F2.2a — extractor de referência fiscal.
 *
 * Recebe uma referência JÁ EXTRAÍDA (payload de QR, URL, chave de acesso ou
 * texto) e devolve um `FiscalReference` normalizado. Não faz I/O: não busca a
 * URL, não resolve DNS e não consulta autorizador. A segurança de rede continua
 * em `safeExternalFetch`/`safeFetchFiscalEndpoint` (F2.1).
 *
 * A extração física do QR (decodificar imagem) é F2.2b; nenhuma dependência
 * nova foi adicionada.
 */

const NF3E_PATH_FRAGMENT = 'nf3e'
const NFAG_PATH_FRAGMENT = 'nfag'

/**
 * Autorizadores NF3e cujo endpoint de QR é observado/documentado. NÃO é a
 * allowlist de consulta (essa nasce vazia em F2.1); é apenas o mapa
 * host → identificador do autorizador. Autorizador desconhecido vira
 * `issuer: null`, nunca um palpite.
 */
const NF3E_ISSUER_BY_HOST: Readonly<Record<string, string>> = {
  'dfe-portal.svrs.rs.gov.br': 'SVRS',
  'sat.sef.sc.gov.br': 'SC',
  'portalsped.fazenda.mg.gov.br': 'MG',
  'www.sefaz.mt.gov.br': 'MT',
}

/** Código IBGE da UF (2 primeiros dígitos da chave de acesso). */
const UF_BY_IBGE_CODE: Readonly<Record<string, string>> = {
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

const KEY_PARAM_NAMES: ReadonlySet<string> = new Set(['chnfe', 'chave', 'chaveacesso', 'chave_acesso'])

const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+/gi
const ACCESS_KEY_IN_TEXT = /\b\d{44}\b/g

interface FoundInput {
  readonly source: FiscalSourceId
  readonly issuer: string | null
  readonly uf: string | null
  readonly url: string | null
  readonly documentId: string | null
  readonly method: FiscalReferenceMethod
  readonly limitations: readonly FiscalReferenceReason[]
}

const base = {
  contractVersion: FISCAL_REFERENCE_CONTRACT_VERSION,
} as const

const notFound = (method: FiscalReferenceMethod): FiscalReference => ({
  ...base,
  status: 'not_found',
  source: null,
  issuer: null,
  uf: null,
  url: null,
  documentId: null,
  method,
  limitations: [],
  errorCodes: [],
  fingerprint: null,
})

const unsupported = (input: {
  readonly method: FiscalReferenceMethod
  readonly reasons: readonly FiscalReferenceReason[]
  readonly source?: FiscalSourceId | null
  readonly issuer?: string | null
  readonly uf?: string | null
  readonly url?: string | null
  readonly documentId?: string | null
}): FiscalReference => ({
  ...base,
  status: 'unsupported',
  source: input.source ?? null,
  issuer: input.issuer ?? null,
  uf: input.uf ?? null,
  url: input.url ?? null,
  documentId: input.documentId ?? null,
  method: input.method,
  limitations: input.reasons,
  errorCodes: input.reasons,
  fingerprint: null,
})

const found = (input: FoundInput): FiscalReference => {
  const reference: FiscalReference = {
    ...base,
    status: 'found',
    source: input.source,
    issuer: input.issuer,
    uf: input.uf,
    url: input.url,
    documentId: input.documentId,
    method: input.method,
    limitations: input.limitations,
    errorCodes: input.limitations,
    fingerprint: null,
  }
  return { ...reference, fingerprint: fiscalReferenceFingerprint(reference) }
}

const compareStrings = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const parseSafeUrl = (raw: string): URL | null => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || !isSafeExternalUrl(raw)) return null
  url.hash = ''
  const entries = [...url.searchParams.entries()].sort(
    ([aKey, aValue], [bKey, bValue]) => compareStrings(aKey, bKey) || compareStrings(aValue, bValue),
  )
  url.search = new URLSearchParams(entries).toString()
  return url
}

const mod11CheckDigit = (base43: string): number | null => {
  if (!/^\d{43}$/.test(base43)) return null
  let sum = 0
  let weight = 2
  for (let index = base43.length - 1; index >= 0; index -= 1) {
    sum += Number(base43[index]) * weight
    weight = weight === 9 ? 2 : weight + 1
  }
  const remainder = sum % 11
  const digit = 11 - remainder
  return digit >= 10 ? 0 : digit
}

const nf3eKeyInfo = (key: string): { readonly uf: string } | null => {
  if (!/^\d{44}$/.test(key)) return null
  const uf = UF_BY_IBGE_CODE[key.slice(0, 2)]
  if (uf === undefined) return null
  // Modelo 66 = NF3e. Qualquer outro modelo é documento fiscal de outra espécie.
  if (key.slice(20, 22) !== '66') return null
  const expected = mod11CheckDigit(key.slice(0, 43))
  if (expected === null || expected !== Number(key[43])) return null
  return { uf }
}

const invalidKeyReason = (key: string): FiscalReferenceReason => {
  if (!/^\d{44}$/.test(key)) return 'INVALID_DOCUMENT_ID'
  if (UF_BY_IBGE_CODE[key.slice(0, 2)] === undefined) return 'INVALID_DOCUMENT_ID'
  if (key.slice(20, 22) !== '66') return 'NOT_NF3E_DOCUMENT'
  return 'INVALID_DOCUMENT_ID'
}

const keyCandidateFromUrl = (url: URL): { readonly present: boolean; readonly key: string | null } => {
  for (const [name, value] of url.searchParams.entries()) {
    if (!KEY_PARAM_NAMES.has(name.toLowerCase())) continue
    const digits = value.replace(/\D+/g, '')
    return { present: true, key: /^\d{44}$/.test(digits) ? digits : null }
  }
  return { present: false, key: null }
}

const referenceFromUrl = (raw: string, method: FiscalReferenceMethod): FiscalReference => {
  const url = parseSafeUrl(raw)
  if (url === null) return unsupported({ method, reasons: ['UNSAFE_REFERENCE_URL'] })

  const normalizedUrl = url.toString()
  const host = url.hostname.toLowerCase()
  const path = url.pathname.toLowerCase()
  const pathHasNf3e = path.includes(NF3E_PATH_FRAGMENT)
  const pathHasNfag = path.includes(NFAG_PATH_FRAGMENT)

  if (pathHasNfag) {
    return unsupported({
      method,
      url: normalizedUrl,
      source: 'nfag-e',
      reasons: ['SOURCE_NOT_SUPPORTED'],
    })
  }

  const issuer = pathHasNf3e ? (NF3E_ISSUER_BY_HOST[host] ?? null) : null
  const hasNf3eEvidence = pathHasNf3e || issuer !== null
  const key = keyCandidateFromUrl(url)

  if (key.present) {
    if (key.key === null) {
      return unsupported({
        method,
        url: normalizedUrl,
        source: hasNf3eEvidence ? 'nf3e' : null,
        issuer,
        reasons: ['INVALID_DOCUMENT_ID'],
      })
    }
    const info = nf3eKeyInfo(key.key)
    if (info === null) {
      return unsupported({
        method,
        url: normalizedUrl,
        source: hasNf3eEvidence ? 'nf3e' : null,
        issuer,
        documentId: key.key,
        reasons: [invalidKeyReason(key.key)],
      })
    }
    return found({
      source: 'nf3e',
      issuer,
      uf: info.uf,
      url: normalizedUrl,
      documentId: key.key,
      method,
      limitations: issuer === null ? ['UNKNOWN_ISSUER'] : [],
    })
  }

  if (issuer !== null) {
    return found({
      source: 'nf3e',
      issuer,
      uf: null,
      url: normalizedUrl,
      documentId: null,
      method,
      limitations: ['DOCUMENT_ID_MISSING'],
    })
  }

  return unsupported({ method, url: normalizedUrl, reasons: ['REFERENCE_NOT_RECOGNIZED'] })
}

const referenceFromKey = (key: string, method: FiscalReferenceMethod): FiscalReference => {
  const info = nf3eKeyInfo(key)
  if (info === null) {
    const reason = invalidKeyReason(key)
    return unsupported({
      method,
      source: reason === 'NOT_NF3E_DOCUMENT' ? null : 'nf3e',
      documentId: key,
      reasons: [reason],
    })
  }
  return found({
    source: 'nf3e',
    issuer: null,
    uf: info.uf,
    url: null,
    documentId: key,
    method,
    limitations: ['UNKNOWN_ISSUER'],
  })
}

const unique = (values: readonly string[]): readonly string[] => [...new Set(values)]

const trimUrlPunctuation = (value: string): string => value.replace(/[.,;:!?]+$/, '')

const referenceFromText = (raw: string, method: FiscalReferenceMethod): FiscalReference => {
  const urls = unique([...raw.matchAll(URL_IN_TEXT)].map((match) => trimUrlPunctuation(match[0])))
  if (urls.length > 1) return unsupported({ method, reasons: ['AMBIGUOUS_REFERENCE'] })
  const url = urls[0]
  if (url !== undefined) return referenceFromUrl(url, method)

  const keys = unique([...raw.matchAll(ACCESS_KEY_IN_TEXT)].map((match) => match[0]))
  if (keys.length > 1) return unsupported({ method, reasons: ['AMBIGUOUS_REFERENCE'] })
  const key = keys[0]
  if (key !== undefined) return referenceFromKey(key, method)

  return notFound(method)
}

const detectMethod = (raw: string): FiscalReferenceMethod => {
  try {
    new URL(raw)
    return 'url'
  } catch {
    return /^\d{44}$/.test(raw) ? 'access_key' : 'text'
  }
}

/**
 * Normaliza uma referência já extraída. `method` descreve a origem; quando
 * omitido, é inferido (URL, chave isolada ou texto). Nunca faz rede.
 */
export const extractFiscalReference = (input: FiscalReferenceExtractionInput): FiscalReference => {
  const raw = (input.value ?? '').trim()
  const method = input.method ?? 'unknown'
  if (raw.length === 0) return notFound(method)
  const resolvedMethod = input.method ?? detectMethod(raw)

  try {
    const single = new URL(raw)
    if (single.protocol === 'https:') return referenceFromUrl(raw, resolvedMethod)
  } catch {
    // não é URL isolada; segue para chave/texto
  }

  if (/^\d{44}$/.test(raw)) return referenceFromKey(raw, resolvedMethod)
  return referenceFromText(raw, resolvedMethod)
}
