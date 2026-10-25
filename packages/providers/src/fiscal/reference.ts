import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  FISCAL_REFERENCE_CONTRACT_VERSION,
  fiscalReferenceFingerprint,
  type FiscalReference,
  type FiscalReferenceExtractionInput,
  type FiscalReferenceMethod,
  type FiscalReferenceReason,
  type FiscalSourceId,
} from '@comprova/core'
import { imageSize } from 'image-size'
import { extractImages, getDocumentProxy } from 'unpdf'
import { prepareZXingModule, readBarcodes, type ReadResult, type ReaderOptions } from 'zxing-wasm/reader'
import { isSafeExternalUrl } from '../safe-fetch.js'

/**
 * F2.2a/F2.2b — extractor de referência fiscal.
 *
 * Duas entradas, o mesmo contrato:
 *
 *   - `extractFiscalReference` recebe uma referência JÁ EXTRAÍDA (payload de
 *     QR, URL, chave de acesso ou texto) e apenas normaliza/classifica;
 *   - `extractFiscalReferenceFromArtifact` decodifica o QR de PNG/JPEG ou de
 *     imagens raster embutidas em PDF e entrega o resultado ao normalizador.
 *
 * Nenhuma das funções faz rede: não busca a URL, não resolve DNS, não segue
 * redirecionamento e não consulta autorizador. O payload do QR é entrada não
 * confiável e nunca escolhe o destino de uma requisição. A segurança de rede
 * continua em `safeExternalFetch`/`safeFetchFiscalEndpoint` (F2.1).
 */

export const FISCAL_REFERENCE_MAX_IMAGE_PIXELS = 16_000_000
export const FISCAL_REFERENCE_MAX_PDF_PAGES = 50
const MAX_IMAGE_EDGE = 10_000
const MAX_PDF_IMAGES = 64
const MAX_QR_SYMBOLS = 8
/**
 * O mínimo é 2: com um único símbolo o decoder não consegue distinguir "um QR"
 * de "mais de um QR truncado", e a política proíbe escolher arbitrariamente o
 * primeiro. O teto é defensivo; na prática um comprovante tem 1 QR.
 */
const MIN_QR_SYMBOLS = 2
const MAX_QR_SYMBOLS_CAP = 32

const resolveMaxSymbols = (value: number | undefined): number => {
  if (value === undefined || !Number.isSafeInteger(value)) return MAX_QR_SYMBOLS
  return Math.min(MAX_QR_SYMBOLS_CAP, Math.max(MIN_QR_SYMBOLS, value))
}

const NFAG_PATH_FRAGMENT = 'nfag'

interface Nf3eEndpoint {
  readonly issuer: string
  readonly path: RegExp
}

/**
 * Autorizadores NF3e cujo endpoint de QR é observado/documentado. NÃO é a
 * allowlist de consulta (essa nasce vazia em F2.1); é o mapa
 * host + caminho esperado → identificador do autorizador. Host ou caminho
 * desconhecido vira `issuer: null`, nunca um palpite.
 */
const NF3E_ENDPOINTS: Readonly<Record<string, Nf3eEndpoint>> = {
  'dfe-portal.svrs.rs.gov.br': { issuer: 'SVRS', path: /^\/nf3e\/qrcode\/?$/i },
  'sat.sef.sc.gov.br': { issuer: 'SC', path: /^\/nf3e\/consulta\/?$/i },
  'portalsped.fazenda.mg.gov.br': {
    issuer: 'MG',
    path: /^\/portalnf3e\/sistema\/qrcode\.xhtml\/?$/i,
  },
  'www.sefaz.mt.gov.br': { issuer: 'MT', path: /^\/nf3e\/qrcode\/?$/i },
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

const notFound = (
  method: FiscalReferenceMethod,
  limitations: readonly FiscalReferenceReason[] = [],
): FiscalReference => ({
  ...base,
  status: 'not_found',
  source: null,
  issuer: null,
  uf: null,
  url: null,
  documentId: null,
  method,
  limitations,
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

const inconclusive = (input: {
  readonly method: FiscalReferenceMethod
  readonly reasons: readonly FiscalReferenceReason[]
}): FiscalReference => ({
  ...base,
  status: 'inconclusive',
  source: null,
  issuer: null,
  uf: null,
  url: null,
  documentId: null,
  method: input.method,
  limitations: input.reasons,
  errorCodes: input.reasons,
  fingerprint: null,
})

/**
 * Referência inconclusiva para falhas de orquestração que acontecem antes da
 * extração (ex.: PDF com páginas demais). Mantém o mesmo contrato do extractor.
 */
export const inconclusiveFiscalReference = (reason: FiscalReferenceReason): FiscalReference =>
  inconclusive({ method: 'qr_code', reasons: [reason] })

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
    errorCodes: [],
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

type KeyCandidate =
  | { readonly status: 'absent' }
  | { readonly status: 'ambiguous' }
  | { readonly status: 'invalid' }
  | { readonly status: 'valid'; readonly key: string }

const keyCandidateFromUrl = (url: URL): KeyCandidate => {
  const values = [...url.searchParams.entries()]
    .filter(([name]) => KEY_PARAM_NAMES.has(name.toLowerCase()))
    .map(([, value]) => value)

  if (values.length === 0) return { status: 'absent' }
  if (values.length > 1) return { status: 'ambiguous' }

  const value = values[0]
  return value !== undefined && /^\d{44}$/.test(value)
    ? { status: 'valid', key: value }
    : { status: 'invalid' }
}

const referenceFromUrl = (raw: string, method: FiscalReferenceMethod): FiscalReference => {
  const url = parseSafeUrl(raw)
  if (url === null) return unsupported({ method, reasons: ['UNSAFE_REFERENCE_URL'] })

  const normalizedUrl = url.toString()
  const host = url.hostname.toLowerCase()
  const path = url.pathname.toLowerCase()
  const pathHasNfag = path.includes(NFAG_PATH_FRAGMENT)

  if (pathHasNfag) {
    return unsupported({
      method,
      url: normalizedUrl,
      source: 'nfag-e',
      reasons: ['SOURCE_NOT_SUPPORTED'],
    })
  }

  const endpoint = NF3E_ENDPOINTS[host]
  const issuer = endpoint !== undefined && endpoint.path.test(path) ? endpoint.issuer : null
  const hasNf3eEvidence = issuer !== null
  const key = keyCandidateFromUrl(url)

  if (key.status === 'ambiguous') {
    return unsupported({
      method,
      url: normalizedUrl,
      source: hasNf3eEvidence ? 'nf3e' : null,
      issuer,
      reasons: ['AMBIGUOUS_REFERENCE'],
    })
  }

  if (key.status === 'invalid') {
    return unsupported({
      method,
      url: normalizedUrl,
      source: hasNf3eEvidence ? 'nf3e' : null,
      issuer,
      reasons: ['INVALID_DOCUMENT_ID'],
    })
  }

  if (key.status === 'valid') {
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

const unique = <T>(values: readonly T[]): readonly T[] => [...new Set(values)]

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
  if (/^https?:\/\/\S+$/i.test(raw)) return 'url'
  return /^\d{44}$/.test(raw) ? 'access_key' : 'text'
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

/**
 * Política determinística para vários símbolos QR na mesma imagem/PDF.
 *
 * - payloads duplicados ou referências com o mesmo fingerprint: `found`;
 * - mais de uma referência fiscal reconhecida e distinta: `unsupported` /
 *   `AMBIGUOUS_REFERENCE` (não escolhe o primeiro QR);
 * - QR fiscal único + QR não fiscal: mantém a referência única e registra a
 *   limitação `MULTIPLE_QR_CODES`;
 * - nenhum QR fiscal: `not_found`; conteúdo fiscal não suportado: `unsupported`.
 *
 * A ordem dos símbolos nunca decide o resultado.
 */
export const extractFiscalReferenceFromPayloads = (payloads: readonly string[]): FiscalReference => {
  const uniquePayloads = unique(
    payloads.map((payload) => payload.trim()).filter((payload) => payload.length > 0),
  )
  if (uniquePayloads.length === 0) return notFound('qr_code')

  const references = uniquePayloads.map((value) => extractFiscalReference({ value, method: 'qr_code' }))
  const recognized = new Map<string, FiscalReference>()

  for (const reference of references) {
    const signature =
      reference.status === 'found'
        ? `found:${reference.fingerprint ?? ''}`
        : reference.status === 'unsupported' && reference.source !== null
          ? `unsupported:${reference.source}:${reference.documentId ?? ''}:${reference.url ?? ''}:${reference.errorCodes.join(',')}`
          : null
    if (signature !== null && !recognized.has(signature)) recognized.set(signature, reference)
  }

  if (recognized.size > 1) {
    return unsupported({ method: 'qr_code', reasons: ['AMBIGUOUS_REFERENCE'] })
  }

  const single = recognized.values().next().value
  if (single !== undefined) {
    if (single.status !== 'found') return single
    const multipleQr = uniquePayloads.length > 1 ? (['MULTIPLE_QR_CODES'] as const) : []
    return { ...single, limitations: unique([...single.limitations, ...multipleQr]) }
  }

  const unsupportedReferences = references.filter((reference) => reference.status === 'unsupported')
  if (unsupportedReferences.length > 0) {
    return unsupported({
      method: 'qr_code',
      reasons: unique(unsupportedReferences.flatMap((reference) => reference.errorCodes)),
    })
  }

  return notFound('qr_code', uniquePayloads.length > 1 ? ['MULTIPLE_QR_CODES'] : [])
}

type PdfProxy = Awaited<ReturnType<typeof getDocumentProxy>>
type PdfImage = Awaited<ReturnType<typeof extractImages>>[number]

interface RgbaImage {
  readonly data: Uint8ClampedArray
  readonly width: number
  readonly height: number
}

export interface FiscalReferenceArtifactInput {
  readonly data: Uint8Array
  readonly contentType: string
}

/**
 * Limites de segurança da extração física. São deliberadamente conservadores:
 * um comprovante não precisa de uma imagem de dezenas de megapixels para ter
 * um QR legível, e o decoder roda no mesmo processo do worker.
 */
export interface FiscalReferenceArtifactOptions {
  readonly maxImagePixels?: number
  readonly maxImageEdge?: number
  readonly maxPdfPages?: number
  readonly maxPdfImages?: number
  readonly maxSymbols?: number
}

class QrDecoderUnavailableError extends Error {}

const require = createRequire(import.meta.url)

let qrReaderReady: Promise<void> | null = null

/**
 * Carrega o WASM do reader somente do pacote instalado. `wasmBinary` elimina
 * qualquer fallback de rede do Emscripten (`locateFile`/fetch): o mesmo caminho
 * funciona em CI, worker e teste, sem CDN.
 */
const instantiateQrReader = async (): Promise<void> => {
  const wasmPath = require.resolve('zxing-wasm/reader/zxing_reader.wasm')
  const wasmFile = readFileSync(wasmPath)
  const wasmBinary = wasmFile.buffer.slice(
    wasmFile.byteOffset,
    wasmFile.byteOffset + wasmFile.byteLength,
  ) as ArrayBuffer

  await prepareZXingModule({
    fireImmediately: true,
    overrides: { wasmBinary },
  })
}

const ensureQrReader = (): Promise<void> => {
  if (qrReaderReady === null) {
    qrReaderReady = instantiateQrReader().catch(() => {
      // Não cacheia a falha: uma chamada posterior pode tentar inicializar de
      // novo em vez de ficar presa em `QR_DECODER_UNAVAILABLE` até reiniciar.
      qrReaderReady = null
      throw new QrDecoderUnavailableError()
    })
  }
  return qrReaderReady
}

const qrReaderOptions = (maxSymbolsToRead: number): ReaderOptions => ({
  formats: ['QRCode'],
  maxNumberOfSymbols: maxSymbolsToRead,
  returnErrors: true,
  tryHarder: true,
  tryRotate: true,
  tryInvert: false,
})

interface SymbolPolicyOptions {
  readonly maxSymbols: number
}

/**
 * Resultado legível é o único que participa da política de referências.
 * `returnErrors` pode acrescentar entradas inválidas (falso positivo/checksum),
 * que não contam como um símbolo fiscal adicional.
 */
const isReadableResult = (result: ReadResult): boolean => result.isValid && result.text.trim().length > 0

/**
 * Consolida os resultados do decoder. Um resultado inválido com `returnErrors`
 * indica um símbolo detectado mas ilegível; nesse caso não afirmamos `not_found`.
 */
const referenceFromSymbols = (
  results: readonly ReadResult[],
  options: SymbolPolicyOptions,
): FiscalReference => {
  const readable = results.filter(isReadableResult)

  // O decoder lê `maxSymbols + 1`; só há truncamento quando esse limite
  // extra é atingido. Exatamente `maxSymbols` referências legíveis ainda
  // passam pela política (duplicata vira found, distintas viram ambíguo).
  if (readable.length > options.maxSymbols) {
    return inconclusive({ method: 'qr_code', reasons: ['QR_TOO_MANY_SYMBOLS'] })
  }

  const unreadable = results.length - readable.length

  if (readable.length === 0) {
    if (unreadable > 0) return inconclusive({ method: 'qr_code', reasons: ['QR_NOT_READABLE'] })
    return notFound('qr_code')
  }

  const reference = extractFiscalReferenceFromPayloads(readable.map((result) => result.text))
  if (reference.status === 'not_found' && unreadable > 0) {
    return inconclusive({ method: 'qr_code', reasons: ['QR_NOT_READABLE'] })
  }
  if ((reference.status === 'found' || reference.status === 'unsupported') && unreadable > 0) {
    return { ...reference, limitations: unique([...reference.limitations, 'QR_NOT_READABLE']) }
  }
  return reference
}

const readQrImage = async (
  input: Uint8Array | RgbaImage,
  maxSymbolsToRead: number,
): Promise<readonly ReadResult[]> => {
  await ensureQrReader()
  return readBarcodes(input as Parameters<typeof readBarcodes>[0], qrReaderOptions(maxSymbolsToRead))
}

const isSafeDimension = (value: number): boolean => Number.isSafeInteger(value) && value > 0

const exceedsImageLimits = (width: number, height: number, maxPixels: number, maxEdge: number): boolean =>
  !isSafeDimension(width) ||
  !isSafeDimension(height) ||
  width > maxEdge ||
  height > maxEdge ||
  !Number.isSafeInteger(width * height) ||
  width * height > maxPixels

const imageToRgba = (image: PdfImage): Uint8ClampedArray | null => {
  const { width, height, channels, data } = image
  if (!isSafeDimension(width) || !isSafeDimension(height)) return null
  if (!Number.isSafeInteger(width * height)) return null
  if (channels !== 1 && channels !== 3 && channels !== 4) return null
  if (data.length !== width * height * channels) return null
  if (channels === 4) return data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data)

  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let pixel = 0, source = 0; pixel < width * height; pixel += 1, source += channels) {
    const target = pixel * 4
    if (channels === 1) {
      const value = data[source] ?? 0
      rgba[target] = value
      rgba[target + 1] = value
      rgba[target + 2] = value
    } else {
      rgba[target] = data[source] ?? 0
      rgba[target + 1] = data[source + 1] ?? 0
      rgba[target + 2] = data[source + 2] ?? 0
    }
    rgba[target + 3] = 255
  }
  return rgba
}

/**
 * Extrai a referência de imagens raster embutidas no PDF. Não renderiza a
 * página e não usa canvas: QR vetorial/desenhado é uma limitação explícita
 * (`PDF_QR_VECTOR_UNSUPPORTED`). A URL nunca é acessada.
 */
export const extractFiscalReferenceFromPdf = async (
  pdf: PdfProxy,
  options: FiscalReferenceArtifactOptions = {},
): Promise<FiscalReference> => {
  const maxImagePixels = options.maxImagePixels ?? FISCAL_REFERENCE_MAX_IMAGE_PIXELS
  const maxImageEdge = options.maxImageEdge ?? MAX_IMAGE_EDGE
  const maxPages = options.maxPdfPages ?? FISCAL_REFERENCE_MAX_PDF_PAGES
  const maxImages = options.maxPdfImages ?? MAX_PDF_IMAGES
  const maxSymbols = resolveMaxSymbols(options.maxSymbols)

  if (pdf.numPages > maxPages) {
    return inconclusive({ method: 'qr_code', reasons: ['PDF_TOO_MANY_PAGES'] })
  }

  const results: ReadResult[] = []
  const seenImageKeys = new Set<string>()
  let imageCount = 0
  let readableCount = 0
  let extractionFailed = false
  let skippedOversized = false

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    let images: readonly PdfImage[]
    try {
      images = await extractImages(pdf, pageNumber)
    } catch {
      extractionFailed = true
      continue
    }

    for (const image of images) {
      if (image.key.length > 0) {
        if (seenImageKeys.has(image.key)) continue
        seenImageKeys.add(image.key)
      }

      imageCount += 1
      if (imageCount > maxImages) {
        return inconclusive({ method: 'qr_code', reasons: ['PDF_TOO_MANY_IMAGES'] })
      }

      if (exceedsImageLimits(image.width, image.height, maxImagePixels, maxImageEdge)) {
        skippedOversized = true
        continue
      }

      const rgba = imageToRgba(image)
      if (rgba === null) {
        extractionFailed = true
        continue
      }

      try {
        const pageResults = await readQrImage(
          { data: rgba, width: image.width, height: image.height },
          maxSymbols + 1,
        )
        results.push(...pageResults)
        readableCount += pageResults.filter(isReadableResult).length
        if (readableCount > maxSymbols) {
          return inconclusive({ method: 'qr_code', reasons: ['QR_TOO_MANY_SYMBOLS'] })
        }
      } catch (error) {
        if (error instanceof QrDecoderUnavailableError) {
          return inconclusive({ method: 'qr_code', reasons: ['QR_DECODER_UNAVAILABLE'] })
        }
        extractionFailed = true
      }
    }
  }

  const failures: FiscalReferenceReason[] = []
  if (skippedOversized) failures.push('IMAGE_TOO_LARGE')
  if (extractionFailed) failures.push('PDF_IMAGE_EXTRACTION_FAILED')
  if (failures.length > 0) return inconclusive({ method: 'qr_code', reasons: failures })

  if (imageCount === 0) {
    return inconclusive({ method: 'qr_code', reasons: ['PDF_QR_VECTOR_UNSUPPORTED'] })
  }

  if (results.length === 0) {
    // Só inspecionamos raster; um QR vetorial no mesmo PDF continua fora do
    // alcance. Como não é possível afirmar ausência absoluta, o resultado é
    // inconclusivo, não `not_found`.
    return inconclusive({ method: 'qr_code', reasons: ['PDF_QR_VECTOR_UNSUPPORTED'] })
  }

  const reference = referenceFromSymbols(results, { maxSymbols })
  if (reference.status === 'not_found') {
    return inconclusive({
      method: 'qr_code',
      reasons: unique([...reference.limitations, 'PDF_QR_VECTOR_UNSUPPORTED']),
    })
  }
  return reference
}

const extractFromImage = async (
  data: Uint8Array,
  contentType: 'image/jpeg' | 'image/png',
  options: FiscalReferenceArtifactOptions,
): Promise<FiscalReference> => {
  const maxImagePixels = options.maxImagePixels ?? FISCAL_REFERENCE_MAX_IMAGE_PIXELS
  const maxImageEdge = options.maxImageEdge ?? MAX_IMAGE_EDGE
  const maxSymbols = resolveMaxSymbols(options.maxSymbols)

  let dimensions: ReturnType<typeof imageSize>
  try {
    dimensions = imageSize(data)
  } catch {
    return inconclusive({ method: 'qr_code', reasons: ['IMAGE_DECODE_FAILED'] })
  }

  const expectedType = contentType === 'image/png' ? 'png' : 'jpg'
  if (dimensions.type !== expectedType) {
    return inconclusive({ method: 'qr_code', reasons: ['IMAGE_DECODE_FAILED'] })
  }
  if (exceedsImageLimits(dimensions.width, dimensions.height, maxImagePixels, maxImageEdge)) {
    return inconclusive({ method: 'qr_code', reasons: ['IMAGE_TOO_LARGE'] })
  }

  let results: readonly ReadResult[]
  try {
    results = await readQrImage(data, maxSymbols + 1)
  } catch (error) {
    if (error instanceof QrDecoderUnavailableError) {
      return inconclusive({ method: 'qr_code', reasons: ['QR_DECODER_UNAVAILABLE'] })
    }
    return inconclusive({ method: 'qr_code', reasons: ['IMAGE_DECODE_FAILED'] })
  }

  return referenceFromSymbols(results, { maxSymbols })
}

const extractFromPdf = async (
  data: Uint8Array,
  options: FiscalReferenceArtifactOptions,
): Promise<FiscalReference> => {
  let pdf: PdfProxy
  try {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    pdf = await getDocumentProxy(bytes, {
      verbosity: 0,
      maxImageSize: options.maxImagePixels ?? FISCAL_REFERENCE_MAX_IMAGE_PIXELS,
    })
  } catch (error) {
    const encrypted = (error as { name?: unknown }).name === 'PasswordException'
    return inconclusive({
      method: 'qr_code',
      reasons: [encrypted ? 'PDF_ENCRYPTED' : 'PDF_INVALID'],
    })
  }

  try {
    return await extractFiscalReferenceFromPdf(pdf, options)
  } catch {
    return inconclusive({ method: 'qr_code', reasons: ['PDF_INVALID'] })
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined)
  }
}

/**
 * Extrai a referência fiscal do artefato físico. Suporta PNG/JPEG e imagens
 * raster embutidas em PDF. O payload decodificado passa pelo mesmo
 * `extractFiscalReference` usado em F2.2a; não há fetch, DNS nem consulta.
 */
export const extractFiscalReferenceFromArtifact = async (
  input: FiscalReferenceArtifactInput,
  options: FiscalReferenceArtifactOptions = {},
): Promise<FiscalReference> => {
  const contentType = (input.contentType.split(';')[0] ?? '').trim().toLowerCase()

  if (input.data.byteLength === 0) {
    return inconclusive({ method: 'qr_code', reasons: ['IMAGE_DECODE_FAILED'] })
  }
  if (contentType === 'application/pdf') return extractFromPdf(input.data, options)
  if (contentType === 'image/png') return extractFromImage(input.data, 'image/png', options)
  if (contentType === 'image/jpeg' || contentType === 'image/jpg') {
    return extractFromImage(input.data, 'image/jpeg', options)
  }

  return unsupported({ method: 'unknown', reasons: ['UNSUPPORTED_ARTIFACT_TYPE'] })
}
