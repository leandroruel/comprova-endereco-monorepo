import {
  FiscalAdapterUnavailableError,
  compareAddress,
  compareHolder,
  emptyFiscalAudit,
  normalizeText,
  type ExtractedAddress,
  type ExtractedHolder,
  type FiscalAdapter,
  type FiscalLookupInput,
  type FiscalReasonCode,
  type FiscalVerificationResult,
  type VerificationEnvironment,
} from '@comprova/core'
import { createHash } from 'node:crypto'
import {
  SafeFetchError,
  isSafeExternalUrl,
  safeExternalFetch,
  type SafeFetch,
  type SafeFetchOptions,
} from '../safe-fetch.js'
import {
  FISCAL_ENDPOINT_ALLOWLIST,
  safeFetchFiscalEndpoint,
  type FiscalEndpointAllowlist,
  type FiscalEndpointRef,
} from './endpoint.js'

/**
 * F2.2b — primeiro adapter fiscal real (NF3e / SVRS / RS / produção).
 *
 * Escopo deliberadamente pequeno:
 *   - um autorizador: SVRS;
 *   - uma UF: RS;
 *   - um ambiente no default: produção;
 *   - um protocolo: formulário HTML público de consulta por QR.
 *
 * O adapter não decide veredito, score, `signal` ou peso de evidência. Ele
 * resolve o endpoint APENAS na allowlist, delega o fetch à guarda única e
 * devolve as três dimensões já existentes. A URL do QR é usada só para checar
 * que a referência pertence ao autorizador suportado; ela nunca é buscada.
 */

export const NF3E_FISCAL_ADAPTER_VERSION = '1.0.0'
export const NF3E_SVRS_ISSUER = 'SVRS'
export const NF3E_SVRS_UF = 'RS'
export const NF3E_CONSULTATION_TIMEOUT_MS = 5_000
export const NF3E_CONSULTATION_MAX_RESPONSE_BYTES = 128 * 1024

const SVRS_QR_HOST = 'dfe-portal.svrs.rs.gov.br'
const SVRS_QR_PATH = /^\/nf3e\/qrcode\/?$/i

export interface Nf3eFiscalAdapterOptions {
  readonly version?: string
  readonly environment?: VerificationEnvironment
  readonly allowlist?: FiscalEndpointAllowlist
  readonly safeFetch?: SafeFetch
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
}

const normalizeIssuer = (issuer: string | null): string => (issuer ?? '').trim().toUpperCase()

const isSvrsQrUrl = (raw: string): boolean => {
  if (!isSafeExternalUrl(raw)) return false
  const url = new URL(raw)
  return url.hostname.toLowerCase() === SVRS_QR_HOST && SVRS_QR_PATH.test(url.pathname)
}

/**
 * A referência só é suportada quando aponta para o autorizador/UF desta fatia.
 * Chave isolada não basta: sem autorizador identificado não há descoberta
 * automática nem fallback para o domínio do QR.
 */
const isSupportedInput = (input: FiscalLookupInput): boolean => {
  if (input.source !== 'nf3e') return false
  if (normalizeIssuer(input.issuer) !== NF3E_SVRS_ISSUER) return false
  if ((input.uf ?? '').toUpperCase() !== NF3E_SVRS_UF) return false
  if (input.documentId === null || !/^\d{44}$/.test(input.documentId)) return false
  // cUF 43 = RS; modelo 66 = NF3e. O DV já foi validado na extração.
  if (input.documentId.slice(0, 2) !== '43') return false
  if (input.documentId.slice(20, 22) !== '66') return false
  // Se houver URL de QR, ela precisa ser a referência SVRS reconhecida.
  return input.qrCodeUrl === null || isSvrsQrUrl(input.qrCodeUrl)
}

const sha256Hex = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')

const emptyAddress = (): ExtractedAddress => ({
  logradouro: null,
  numero: null,
  complemento: null,
  bairro: null,
  cidade: null,
  uf: null,
  cep: null,
  raw: '',
})

const emptyHolder = (): ExtractedHolder => ({ name: null, raw: '' })

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  aacute: 'á',
  agrave: 'à',
  acirc: 'â',
  atilde: 'ã',
  auml: 'ä',
  ccedil: 'ç',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  iacute: 'í',
  oacute: 'ó',
  ograve: 'ò',
  ocirc: 'ô',
  otilde: 'õ',
  uacute: 'ú',
  uuml: 'ü',
  ordm: 'º',
  ordf: 'ª',
  deg: '°',
}

const decodeHtmlEntities = (value: string): string =>
  value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase()
    if (lower.startsWith('#x')) {
      try {
        return String.fromCodePoint(Number.parseInt(lower.slice(2), 16))
      } catch {
        return match
      }
    }
    if (lower.startsWith('#')) {
      try {
        return String.fromCodePoint(Number.parseInt(lower.slice(1), 10))
      } catch {
        return match
      }
    }
    return NAMED_ENTITIES[lower] ?? match
  })

const cellText = (html: string): string =>
  decodeHtmlEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()

const normalizeLabel = (value: string): string => normalizeText(value).replace(/[^A-Z0-9]+/g, '')

const sectionHtml = (html: string, id: string, nextIds: readonly string[]): string => {
  const startPattern = new RegExp(`id\\s*=\\s*["']${id}["']`, 'i')
  const start = html.search(startPattern)
  if (start < 0) return ''
  const next = nextIds
    .map((nextId) => html.search(new RegExp(`id\\s*=\\s*["']${nextId}["']`, 'i')))
    .filter((index) => index > start)
  const end = next.length === 0 ? html.length : Math.min(...next)
  return html.slice(start, end)
}

const tableFields = (section: string): ReadonlyMap<string, string> => {
  const fields = new Map<string, string>()
  for (const table of section.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [...(table[1] ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    let labels: readonly string[] | null = null
    for (const row of rows) {
      const rowHtml = row[1] ?? ''
      const headers = [...rowHtml.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((match) =>
        cellText(match[1] ?? ''),
      )
      if (headers.length > 0) labels = headers

      const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) =>
        cellText(match[1] ?? ''),
      )
      if (labels === null || cells.length === 0) continue
      cells.forEach((value, index) => {
        const label = labels?.[index]
        if (label !== undefined && value !== '') fields.set(normalizeLabel(label), value)
      })
    }
  }
  return fields
}

const firstField = (fields: ReadonlyMap<string, string>, names: readonly string[]): string | null => {
  for (const name of names) {
    const value = fields.get(name)
    if (value !== undefined && value !== '') return value
  }
  return null
}

export interface ParsedNf3eFound {
  readonly status: 'found'
  readonly address: ExtractedAddress | null
  readonly holder: ExtractedHolder | null
}

export type ParsedNf3eQrConsultation =
  | ParsedNf3eFound
  | { readonly status: 'not_found' }
  | { readonly status: 'invalid' }
  | { readonly status: 'unrecognized' }

/**
 * Parser mínimo e deliberadamente específico para o HTML de consulta por QR.
 * Não é um parser HTML genérico, não interpreta eventos/cancelamento e não
 * devolve o corpo bruto.
 */
export const parseNf3eQrConsultationResponse = (html: string): ParsedNf3eQrConsultation => {
  const normalized = decodeHtmlEntities(html)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
  if (/205\s*-\s*o\s+nf3e\s+nao\s+consta/.test(normalized)) return { status: 'not_found' }
  if (/20[1-4]\s*-\s*problemas/.test(normalized)) return { status: 'invalid' }

  const recipient = sectionHtml(html, 'destinatario', ['produtos', 'eventos', 'servicos', 'dadosNF3e'])
  if (/id\s*=\s*["']nf3eqrcode["']/i.test(html) && recipient !== '') {
    const fields = tableFields(recipient)
    const holderName = firstField(fields, ['NOMERAZAOSOCIAL', 'RAZAOSOCIAL', 'NOME'])
    const logradouro = firstField(fields, ['LOGRADOURO', 'ENDERECO', 'RUA'])
    const numero = firstField(fields, ['NUMERO', 'NRO', 'NUM'])
    const complemento = firstField(fields, ['COMPLEMENTO', 'COMPL'])
    const bairro = firstField(fields, ['BAIRRO'])
    const cidade = firstField(fields, ['MUNICIPIO', 'CIDADE'])
    const uf = firstField(fields, ['UF'])
    const cep = firstField(fields, ['CEP'])

    const hasAddress = [logradouro, numero, complemento, bairro, cidade, uf, cep].some(
      (value) => value !== null,
    )
    return {
      status: 'found',
      address: hasAddress ? { logradouro, numero, complemento, bairro, cidade, uf, cep, raw: '' } : null,
      holder: holderName === null ? null : { name: holderName, raw: '' },
    }
  }

  return { status: 'unrecognized' }
}

interface ResultOverrides {
  readonly document: FiscalVerificationResult['document']
  readonly address?: FiscalVerificationResult['address']
  readonly holder?: FiscalVerificationResult['holder']
  readonly limitations?: readonly string[]
  readonly errorCodes?: readonly string[]
  readonly audit?: FiscalVerificationResult['audit']
}

const resultOf = (
  input: FiscalLookupInput,
  version: string,
  environment: VerificationEnvironment,
  observedAt: Date,
  overrides: ResultOverrides,
): FiscalVerificationResult => ({
  source: 'nf3e',
  adapterVersion: version,
  method: 'official_qr_consultation',
  environment,
  document: overrides.document,
  address: overrides.address ?? 'not_extracted',
  holder: overrides.holder ?? 'not_extracted',
  issuer: NF3E_SVRS_ISSUER,
  documentId: input.documentId,
  issuedAt: null,
  observedAt,
  limitations: overrides.limitations ?? [],
  errorCodes: overrides.errorCodes ?? [],
  artifact: input.artifact,
  audit: overrides.audit ?? emptyFiscalAudit(),
})

const unavailableReasonOf = (error: unknown): FiscalReasonCode =>
  error instanceof SafeFetchError && error.reason === 'TIMEOUT' ? 'SEFAZ_TIMEOUT' : 'SOURCE_UNAVAILABLE'

const requestBodyOf = (input: FiscalLookupInput, environment: VerificationEnvironment): string => {
  const key = input.documentId ?? ''
  return new URLSearchParams({
    'pesq.Sistema': 'Nf3e',
    'pesq.tpAmb': environment === 'production' ? '1' : '2',
    'pesq.chBpe': key,
    'pesq.chCte': key,
    'pesq.chMdfe': key,
  }).toString()
}

/**
 * Fábrica do adapter real. O default usa produção/SVRS e a guarda de produção;
 * testes injetam allowlist/ambiente/fetch local sem criar um segundo caminho de
 * rede.
 */
export const makeNf3eFiscalAdapter = (options: Nf3eFiscalAdapterOptions = {}): FiscalAdapter => {
  const version = options.version ?? NF3E_FISCAL_ADAPTER_VERSION
  const environment = options.environment ?? 'production'
  const allowlist = options.allowlist ?? FISCAL_ENDPOINT_ALLOWLIST
  const safeFetch = options.safeFetch ?? safeExternalFetch

  return {
    source: 'nf3e',
    version,
    supports: isSupportedInput,
    verify: async (input, context) => {
      if (!isSupportedInput(input)) {
        throw new FiscalAdapterUnavailableError('SOURCE_NOT_SUPPORTED')
      }

      const observedAt = context.now()
      const ref: FiscalEndpointRef = {
        source: 'nf3e',
        issuer: NF3E_SVRS_ISSUER,
        environment,
      }
      const endpoint = allowlist.resolve(ref)
      if (endpoint === null) {
        return resultOf(input, version, environment, observedAt, {
          document: 'unavailable',
          limitations: ['SOURCE_UNAVAILABLE'],
          errorCodes: ['SOURCE_UNAVAILABLE'],
        })
      }

      const safeFetchOptions: SafeFetchOptions = {
        method: 'POST',
        headers: {
          accept: 'text/html',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: requestBodyOf(input, environment),
        allowedContentTypes: ['text/html'],
        timeoutMs: options.timeoutMs ?? NF3E_CONSULTATION_TIMEOUT_MS,
        maxResponseBytes: options.maxResponseBytes ?? NF3E_CONSULTATION_MAX_RESPONSE_BYTES,
      }

      let response
      try {
        response = await safeFetchFiscalEndpoint({
          allowlist,
          ref,
          safeFetch,
          options: safeFetchOptions,
        })
      } catch (error) {
        const reason = unavailableReasonOf(error)
        return resultOf(input, version, environment, observedAt, {
          document: 'unavailable',
          limitations: [reason],
          errorCodes: [reason],
          audit: { ...emptyFiscalAudit(), requestedUrl: endpoint.url },
        })
      }

      const audit = {
        requestedUrl: endpoint.url,
        resolvedIp: response.address,
        responseStatus: response.status,
        responseSha256: sha256Hex(response.body),
      }

      if (response.status !== 200) {
        return resultOf(input, version, environment, observedAt, {
          document: 'unavailable',
          limitations: ['SOURCE_UNAVAILABLE'],
          errorCodes: ['SOURCE_UNAVAILABLE'],
          audit,
        })
      }

      const parsed = parseNf3eQrConsultationResponse(response.body.toString('utf8'))
      if (parsed.status === 'not_found') {
        return resultOf(input, version, environment, observedAt, {
          document: 'not_found',
          audit,
        })
      }
      if (parsed.status === 'invalid') {
        return resultOf(input, version, environment, observedAt, {
          document: 'invalid',
          audit,
        })
      }
      if (parsed.status === 'unrecognized') {
        return resultOf(input, version, environment, observedAt, {
          document: 'inconclusive',
          limitations: ['ADAPTER_ERROR'],
          errorCodes: ['ADAPTER_ERROR'],
          audit,
        })
      }

      const address = compareAddress(parsed.address ?? emptyAddress(), context.claim.address)
      const holder = compareHolder(parsed.holder ?? emptyHolder(), context.claim.holder)
      return resultOf(input, version, environment, observedAt, {
        document: 'authentic',
        address: address.outcome,
        holder: holder.outcome,
        audit,
      })
    },
  }
}
