import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { LookupFunction } from 'node:net'
import { request as httpsRequest } from 'node:https'
import type { RequestOptions } from 'node:https'
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http'
import ipaddr from 'ipaddr.js'

/**
 * Guarda única de fetch externo (F0.2 / ADR-0036).
 *
 * Toda requisição externa iniciada pelo servidor deve passar por aqui. A guarda:
 *   - aceita somente `https:`;
 *   - resolve o hostname e rejeita loopback, RFC1918, link-local, metadata,
 *     IPv6 local e faixas reservadas;
 *   - fixa o IP validado no `lookup` da conexão (proteção contra DNS rebinding);
 *   - não segue redirect (3xx é erro);
 *   - limita tempo, headers, corpo e content-type;
 *   - não aceita opções que desliguem essas proteções.
 *
 * O log é responsabilidade do caller: registre apenas `SafeFetchError.reason`,
 * `SafeFetchError.hostname` e identificadores internos. Nunca logue URL completa,
 * headers, corpo, tokens ou PII.
 */

export const SAFE_FETCH_REASONS = [
  'INVALID_URL',
  'INVALID_PROTOCOL',
  'CREDENTIALS_IN_URL',
  'HOST_RESOLUTION_FAILED',
  'PRIVATE_IP',
  'LOOPBACK_IP',
  'LINK_LOCAL_IP',
  'METADATA_IP',
  'RESERVED_IP',
  'REDIRECT_BLOCKED',
  'RESPONSE_TOO_LARGE',
  'HEADERS_TOO_LARGE',
  'CONTENT_TYPE_NOT_ALLOWED',
  'TIMEOUT',
  'REQUEST_FAILED',
  'INVALID_REQUEST',
] as const

export type SafeFetchReason = (typeof SAFE_FETCH_REASONS)[number]

export interface SafeFetchErrorOptions {
  readonly hostname?: string | null
  readonly status?: number | null
  readonly cause?: unknown
}

export class SafeFetchError extends Error {
  readonly reason: SafeFetchReason
  readonly hostname: string | null
  readonly status: number | null

  constructor(reason: SafeFetchReason, message: string = reason, options: SafeFetchErrorOptions = {}) {
    super(message, { cause: options.cause })
    this.name = 'SafeFetchError'
    this.reason = reason
    this.hostname = options.hostname ?? null
    this.status = options.status ?? null
  }
}

export interface SafeFetchOptions {
  readonly method?: 'GET' | 'POST' | 'HEAD'
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Uint8Array
  /** Se informado, a resposta precisa ter um destes MIME types (sem parâmetros). */
  readonly allowedContentTypes?: readonly string[]
  /** Limitado a [1s, 15s]; default 8s. */
  readonly timeoutMs?: number
  /** Limitado a [1 KiB, 5 MiB]; default 256 KiB. */
  readonly maxResponseBytes?: number
  /** Limitado a [4 KiB, 64 KiB]; default 16 KiB. */
  readonly maxHeaderBytes?: number
}

export interface SafeFetchResponse {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
  /** IP validado efetivamente usado na conexão. */
  readonly address: string
}

export type SafeFetch = (url: string, options?: SafeFetchOptions) => Promise<SafeFetchResponse>

export interface ResolvedAddress {
  readonly address: string
  readonly family: 4 | 6
}

export type SafeFetchResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>

/**
 * Injeta apenas a conexão de transporte. Ainda é a guarda que valida URL, DNS,
 * IP, redirect, limites e content-type. Usado pelo teste com servidor HTTPS
 * local; produção usa `https.request` direto.
 */
export type SafeFetchTransport = (options: RequestOptions) => ClientRequest

export interface SafeFetchFactoryOptions {
  readonly resolve?: SafeFetchResolver
  readonly transport?: SafeFetchTransport
  /** CA extra, apenas para o teste local com certificado autoassinado. */
  readonly ca?: string | Buffer | (string | Buffer)[]
}

export const SAFE_FETCH_CONNECT_TIMEOUT_MS = 3_000
export const SAFE_FETCH_DEFAULT_TIMEOUT_MS = 8_000
export const SAFE_FETCH_DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024
export const SAFE_FETCH_DEFAULT_MAX_HEADER_BYTES = 16 * 1024
export const SAFE_FETCH_MAX_REQUEST_BYTES = 1024 * 1024

const SAFE_FETCH_MIN_TIMEOUT_MS = 1_000
const SAFE_FETCH_MAX_TIMEOUT_MS = 15_000
const SAFE_FETCH_MIN_RESPONSE_BYTES = 1024
const SAFE_FETCH_MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const SAFE_FETCH_MIN_HEADER_BYTES = 4 * 1024
const SAFE_FETCH_MAX_HEADER_BYTES = 64 * 1024

const METADATA_IPS = new Set([
  '169.254.169.254', // AWS/GCP/Azure IMDS
  '169.254.170.2', // ECS task metadata
  '100.100.100.200', // Alibaba Cloud metadata
  'fd00:ec2::254', // AWS IMDS IPv6
])

const FORBIDDEN_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'te',
  'trailer',
])

const clamp = (value: number | undefined, min: number, max: number, fallback: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

const normalizeHostname = (hostname: string): string =>
  hostname
    .replace(/^\[|\]$/g, '')
    .trim()
    .toLowerCase()

const normalizeContentType = (value: string): string => (value.split(';')[0] ?? '').trim().toLowerCase()

/**
 * Classifica um IP literal. Retorna `null` somente para unicast global.
 * IPv4 mapeado em IPv6 é convertido antes da classificação.
 */
export const classifyIpAddress = (address: string): SafeFetchReason | null => {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6
  try {
    parsed = ipaddr.parse(address.trim())
  } catch {
    return 'RESERVED_IP'
  }

  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    return classifyIpAddress(parsed.toIPv4Address().toString())
  }

  const canonical = parsed.toString().toLowerCase()
  const normalized = parsed.toNormalizedString().toLowerCase()
  if (METADATA_IPS.has(canonical) || METADATA_IPS.has(normalized)) return 'METADATA_IP'

  switch (parsed.range()) {
    case 'unicast':
      return null
    case 'loopback':
      return 'LOOPBACK_IP'
    case 'private':
    case 'uniqueLocal':
    case 'carrierGradeNat':
      return 'PRIVATE_IP'
    case 'linkLocal':
      return 'LINK_LOCAL_IP'
    case 'unspecified':
    case 'multicast':
    case 'broadcast':
    case 'reserved':
    case 'benchmarking':
    case 'amt':
    case 'as112':
    case 'as112v6':
    case 'orchid2':
    case 'droneRemoteIdProtocolEntityTags':
    case 'rfc6052':
    case 'rfc6145':
    case '6to4':
    case 'teredo':
    case 'ipv4Mapped':
      return 'RESERVED_IP'
    default:
      return 'RESERVED_IP'
  }
}

const parseExternalUrl = (raw: string): URL => {
  let url: URL
  try {
    url = new URL(raw)
  } catch (cause) {
    throw new SafeFetchError('INVALID_URL', 'URL inválida', { cause })
  }

  if (url.protocol !== 'https:') {
    throw new SafeFetchError('INVALID_PROTOCOL', 'somente https é permitido', { hostname: url.hostname })
  }
  if (url.username !== '' || url.password !== '') {
    throw new SafeFetchError('CREDENTIALS_IN_URL', 'credenciais embutidas na URL não são permitidas', {
      hostname: url.hostname,
    })
  }

  const hostname = normalizeHostname(url.hostname)
  if (hostname === '') {
    throw new SafeFetchError('INVALID_URL', 'host ausente', { hostname: null })
  }
  const policyHostname = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname
  if (policyHostname === 'localhost' || policyHostname.endsWith('.localhost')) {
    throw new SafeFetchError('LOOPBACK_IP', 'localhost não é permitido', { hostname })
  }

  const family = isIP(policyHostname)
  if (family !== 0) {
    const reason = classifyIpAddress(policyHostname)
    if (reason !== null) {
      throw new SafeFetchError(reason, 'IP literal não permitido', { hostname })
    }
  }

  return url
}

/**
 * Checagem síncrona de sintaxe para UX no cadastro. NÃO resolve DNS e NÃO
 * substitui `safeExternalFetch` no momento do envio.
 */
export const isSafeExternalUrl = (raw: string): boolean => {
  try {
    parseExternalUrl(raw)
    return true
  } catch {
    return false
  }
}

const defaultResolve: SafeFetchResolver = async (hostname) => {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true })
  return addresses.map(({ address }) => {
    const family = isIP(address)
    if (family !== 4 && family !== 6) {
      throw new SafeFetchError('HOST_RESOLUTION_FAILED', 'resolver devolveu endereço inválido', { hostname })
    }
    return { address, family }
  })
}

const resolveAndValidate = async (
  hostname: string,
  resolve: SafeFetchResolver,
): Promise<readonly ResolvedAddress[]> => {
  const literalFamily = isIP(hostname)
  const addresses: readonly ResolvedAddress[] =
    literalFamily === 4 || literalFamily === 6
      ? [{ address: hostname, family: literalFamily as 4 | 6 }]
      : await resolve(hostname).catch((cause: unknown) => {
          throw new SafeFetchError('HOST_RESOLUTION_FAILED', 'falha ao resolver host', { hostname, cause })
        })

  if (addresses.length === 0) {
    throw new SafeFetchError('HOST_RESOLUTION_FAILED', 'host sem endereço', { hostname })
  }

  const validated: ResolvedAddress[] = []
  for (const candidate of addresses) {
    const family = isIP(candidate.address)
    if (family !== 4 && family !== 6) {
      throw new SafeFetchError('HOST_RESOLUTION_FAILED', 'resolver devolveu endereço inválido', { hostname })
    }
    const reason = classifyIpAddress(candidate.address)
    if (reason !== null) {
      throw new SafeFetchError(reason, 'destino não permitido', { hostname })
    }
    validated.push({ address: candidate.address, family })
  }

  return validated
}

const resolveWithTimeout = async (
  hostname: string,
  resolve: SafeFetchResolver,
  timeoutMs: number,
): Promise<readonly ResolvedAddress[]> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      resolveAndValidate(hostname, resolve),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SafeFetchError('TIMEOUT', 'timeout ao resolver host', { hostname })),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const normalizeHeaders = (headers: Readonly<Record<string, string>> | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    const name = key.toLowerCase()
    if (FORBIDDEN_HEADERS.has(name)) {
      throw new SafeFetchError('INVALID_REQUEST', `header não permitido: ${name}`)
    }
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
      throw new SafeFetchError('INVALID_REQUEST', 'header inválido')
    }
    out[name] = value
  }
  return out
}

const normalizeAllowedContentTypes = (values: readonly string[] | undefined): ReadonlySet<string> =>
  new Set((values ?? []).map(normalizeContentType).filter((value) => value !== ''))

const defaultTransport: SafeFetchTransport = (options) => httpsRequest(options)

/**
 * Cria uma instância da guarda. Em produção use `safeExternalFetch`; esta
 * factory só existe para o teste de integração com servidor HTTPS local.
 */
export const createSafeExternalFetch = (factory: SafeFetchFactoryOptions = {}): SafeFetch => {
  const resolve = factory.resolve ?? defaultResolve
  const transport = factory.transport ?? defaultTransport

  return async (rawUrl, options = {}) => {
    const url = parseExternalUrl(rawUrl)
    const hostname = normalizeHostname(url.hostname)
    const method = (options.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'POST' && method !== 'HEAD') {
      throw new SafeFetchError('INVALID_REQUEST', 'método não permitido', { hostname })
    }

    const body =
      options.body === undefined
        ? undefined
        : typeof options.body === 'string'
          ? Buffer.from(options.body)
          : Buffer.from(options.body)
    if (body !== undefined && body.byteLength > SAFE_FETCH_MAX_REQUEST_BYTES) {
      throw new SafeFetchError('INVALID_REQUEST', 'corpo da requisição acima do limite', { hostname })
    }
    if (body !== undefined && method !== 'POST') {
      throw new SafeFetchError('INVALID_REQUEST', 'corpo só é permitido em POST', { hostname })
    }

    const headers = normalizeHeaders(options.headers)
    if (body !== undefined) headers['content-length'] = String(body.byteLength)
    if (headers['accept-encoding'] === undefined) headers['accept-encoding'] = 'identity'

    const allowedContentTypes = normalizeAllowedContentTypes(options.allowedContentTypes)
    const timeoutMs = clamp(
      options.timeoutMs,
      SAFE_FETCH_MIN_TIMEOUT_MS,
      SAFE_FETCH_MAX_TIMEOUT_MS,
      SAFE_FETCH_DEFAULT_TIMEOUT_MS,
    )
    const maxResponseBytes = clamp(
      options.maxResponseBytes,
      SAFE_FETCH_MIN_RESPONSE_BYTES,
      SAFE_FETCH_MAX_RESPONSE_BYTES,
      SAFE_FETCH_DEFAULT_MAX_RESPONSE_BYTES,
    )
    const maxHeaderBytes = clamp(
      options.maxHeaderBytes,
      SAFE_FETCH_MIN_HEADER_BYTES,
      SAFE_FETCH_MAX_HEADER_BYTES,
      SAFE_FETCH_DEFAULT_MAX_HEADER_BYTES,
    )

    const startedAt = Date.now()
    const addresses = await resolveWithTimeout(
      hostname,
      resolve,
      Math.min(SAFE_FETCH_CONNECT_TIMEOUT_MS, timeoutMs),
    )
    const remainingMs = timeoutMs - (Date.now() - startedAt)
    if (remainingMs <= 0) {
      throw new SafeFetchError('TIMEOUT', 'timeout', { hostname })
    }
    // Valida TODOS os IPs. Para a conexão, prefere IPv4 quando disponível.
    const chosen = addresses.find((address) => address.family === 4) ?? addresses[0]
    if (chosen === undefined) {
      throw new SafeFetchError('HOST_RESOLUTION_FAILED', 'host sem endereço', { hostname })
    }

    // O `lookup` devolve sempre o IP já validado. O Node não faz uma segunda
    // resolução DNS: a conexão efetiva usa este endereço, mesmo que o DNS mude
    // depois (DNS rebinding).
    const pinnedLookup: LookupFunction = (_host, lookupOptions, callback) => {
      // Com `autoSelectFamily` (default no Node 22), o runtime chama o lookup
      // com `all: true` e espera uma lista. O IP é o mesmo nos dois formatos.
      if (lookupOptions.all === true) {
        callback(null, [{ address: chosen.address, family: chosen.family }])
        return
      }
      callback(null, chosen.address, chosen.family)
    }

    const requestOptions: RequestOptions = {
      protocol: 'https:',
      hostname,
      port: url.port === '' ? 443 : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      lookup: pinnedLookup,
      servername: isIP(hostname) === 0 ? hostname : undefined,
      rejectUnauthorized: true,
      maxHeaderSize: maxHeaderBytes,
      ...(factory.ca !== undefined ? { ca: factory.ca } : {}),
    }

    return new Promise<SafeFetchResponse>((resolvePromise, rejectPromise) => {
      let settled = false
      let responseEnded = false
      let request: ClientRequest | undefined
      const timeoutRef: { timer?: NodeJS.Timeout } = {}

      const fail = (error: SafeFetchError): void => {
        if (settled) return
        settled = true
        if (timeoutRef.timer !== undefined) clearTimeout(timeoutRef.timer)
        request?.destroy()
        rejectPromise(error)
      }

      timeoutRef.timer = setTimeout(
        () => fail(new SafeFetchError('TIMEOUT', 'timeout', { hostname })),
        remainingMs,
      )

      try {
        request = transport(requestOptions)
      } catch (cause) {
        if (timeoutRef.timer !== undefined) clearTimeout(timeoutRef.timer)
        rejectPromise(
          new SafeFetchError('REQUEST_FAILED', 'falha ao iniciar requisição', { hostname, cause }),
        )
        return
      }

      request.setTimeout(Math.min(SAFE_FETCH_CONNECT_TIMEOUT_MS, remainingMs), () =>
        fail(new SafeFetchError('TIMEOUT', 'timeout', { hostname })),
      )

      request.on('error', (error: Error) => {
        if (error instanceof SafeFetchError) {
          fail(error)
          return
        }
        if ((error as NodeJS.ErrnoException).code === 'HPE_HEADER_OVERFLOW') {
          fail(new SafeFetchError('HEADERS_TOO_LARGE', 'headers acima do limite', { hostname, cause: error }))
          return
        }
        fail(new SafeFetchError('REQUEST_FAILED', 'falha na requisição', { hostname, cause: error }))
      })

      request.on('response', (response: IncomingMessage) => {
        const status = response.statusCode ?? 0
        if (status === 0) {
          response.resume()
          fail(new SafeFetchError('REQUEST_FAILED', 'resposta sem status HTTP', { hostname }))
          return
        }
        if (status >= 300 && status < 400) {
          response.resume()
          fail(new SafeFetchError('REDIRECT_BLOCKED', 'redirect não é seguido', { hostname, status }))
          return
        }

        const rawContentType = response.headers['content-type']
        const contentType = typeof rawContentType === 'string' ? normalizeContentType(rawContentType) : null
        let missingContentType = false

        if (allowedContentTypes.size > 0) {
          if (contentType !== null) {
            if (!allowedContentTypes.has(contentType)) {
              response.resume()
              fail(
                new SafeFetchError('CONTENT_TYPE_NOT_ALLOWED', 'content-type não permitido', {
                  hostname,
                  status,
                }),
              )
              return
            }
          } else if (status !== 204 && status !== 205 && response.headers['content-length'] !== '0') {
            // Pode ser um 200 vazio sem content-type; decide no fim, pelo corpo.
            missingContentType = true
          }
        }

        const chunks: Buffer[] = []
        let total = 0

        response.on('data', (chunk: Buffer) => {
          if (settled) return
          total += chunk.byteLength
          if (total > maxResponseBytes) {
            fail(new SafeFetchError('RESPONSE_TOO_LARGE', 'resposta acima do limite', { hostname, status }))
            return
          }
          chunks.push(chunk)
        })

        response.on('end', () => {
          responseEnded = true
          if (settled) return
          if (missingContentType && total > 0) {
            fail(new SafeFetchError('CONTENT_TYPE_NOT_ALLOWED', 'content-type ausente', { hostname, status }))
            return
          }
          settled = true
          if (timeoutRef.timer !== undefined) clearTimeout(timeoutRef.timer)
          resolvePromise({
            status,
            headers: response.headers,
            body: Buffer.concat(chunks),
            address: chosen.address,
          })
        })

        response.on('error', (error: Error) => {
          fail(
            new SafeFetchError('REQUEST_FAILED', 'falha ao ler resposta', { hostname, status, cause: error }),
          )
        })

        response.on('aborted', () => {
          fail(new SafeFetchError('REQUEST_FAILED', 'resposta abortada', { hostname, status }))
        })
      })

      request.on('close', () => {
        if (!settled && !responseEnded) {
          fail(new SafeFetchError('REQUEST_FAILED', 'conexão encerrada antes da resposta', { hostname }))
        }
      })

      try {
        request.end(body)
      } catch (cause) {
        fail(new SafeFetchError('REQUEST_FAILED', 'falha ao enviar corpo', { hostname, cause }))
      }
    })
  }
}

/** Instância de produção: sem injeção de resolver, transporte ou CA. */
export const safeExternalFetch: SafeFetch = createSafeExternalFetch()
