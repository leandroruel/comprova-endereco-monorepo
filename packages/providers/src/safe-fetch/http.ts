import type { ClientRequest, IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'
import type { RequestOptions } from 'node:https'
import type { LookupFunction } from 'node:net'
import { SafeFetchError } from './errors.js'
import {
  SAFE_FETCH_CONNECT_TIMEOUT_MS,
  SAFE_FETCH_DEFAULT_MAX_HEADER_BYTES,
  SAFE_FETCH_DEFAULT_MAX_RESPONSE_BYTES,
  SAFE_FETCH_DEFAULT_TIMEOUT_MS,
  SAFE_FETCH_MAX_REQUEST_BYTES,
  type ResolvedAddress,
  type SafeFetch,
  type SafeFetchFactoryOptions,
  type SafeFetchOptions,
  type SafeFetchResponse,
  type SafeFetchTransport,
} from './types.js'
import {
  clamp,
  defaultResolve,
  normalizeAllowedContentTypes,
  normalizeContentType,
  normalizeHostname,
  parseExternalUrl,
  prepareHeaders,
  resolveWithTimeout,
} from './validation.js'

const SAFE_FETCH_MIN_TIMEOUT_MS = 1_000
const SAFE_FETCH_MAX_TIMEOUT_MS = 15_000
const SAFE_FETCH_MIN_RESPONSE_BYTES = 1024
const SAFE_FETCH_MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const SAFE_FETCH_MIN_HEADER_BYTES = 4 * 1024
const SAFE_FETCH_MAX_HEADER_BYTES = 64 * 1024

interface RequestContext {
  readonly hostname: string
  readonly signal: AbortSignal
}

interface ResponseContext {
  readonly hostname: string
  readonly allowedContentTypes: ReadonlySet<string>
  readonly maxResponseBytes: number
  readonly signal: AbortSignal
}

interface BodyContext {
  readonly hostname: string
  readonly status: number
  readonly signal: AbortSignal
}

const defaultTransport: SafeFetchTransport = (options) => httpsRequest(options)

const normalizeMethod = (method: SafeFetchOptions['method'], hostname: string): 'GET' | 'POST' | 'HEAD' => {
  const normalized = (method ?? 'GET').toUpperCase()
  if (normalized !== 'GET' && normalized !== 'POST' && normalized !== 'HEAD') {
    throw new SafeFetchError('INVALID_REQUEST', 'método não permitido', { hostname })
  }
  return normalized
}

const normalizeBody = (body: SafeFetchOptions['body']): Buffer | undefined =>
  body === undefined ? undefined : Buffer.from(body)

const validateRequestBody = (
  method: 'GET' | 'POST' | 'HEAD',
  body: Buffer | undefined,
  hostname: string,
): void => {
  if (body !== undefined && body.byteLength > SAFE_FETCH_MAX_REQUEST_BYTES) {
    throw new SafeFetchError('INVALID_REQUEST', 'corpo da requisição acima do limite', { hostname })
  }
  if (body !== undefined && method !== 'POST') {
    throw new SafeFetchError('INVALID_REQUEST', 'corpo só é permitido em POST', { hostname })
  }
}

const createPinnedLookup =
  (chosen: ResolvedAddress): LookupFunction =>
  (_host, lookupOptions, callback) => {
    if (lookupOptions.all === true) {
      callback(null, [{ address: chosen.address, family: chosen.family }])
      return
    }
    callback(null, chosen.address, chosen.family)
  }

const createRequest = (
  transport: SafeFetchTransport,
  options: RequestOptions,
  hostname: string,
): ClientRequest => {
  try {
    return transport(options)
  } catch (cause) {
    throw new SafeFetchError('REQUEST_FAILED', 'falha ao iniciar requisição', { hostname, cause })
  }
}

const toRequestError = (error: Error, context: RequestContext): SafeFetchError => {
  if (error instanceof SafeFetchError) return error
  if (context.signal.aborted) {
    return new SafeFetchError('TIMEOUT', 'timeout', { hostname: context.hostname, cause: error })
  }
  if ((error as NodeJS.ErrnoException).code === 'HPE_HEADER_OVERFLOW') {
    return new SafeFetchError('HEADERS_TOO_LARGE', 'headers acima do limite', {
      hostname: context.hostname,
      cause: error,
    })
  }
  return new SafeFetchError('REQUEST_FAILED', 'falha na requisição', {
    hostname: context.hostname,
    cause: error,
  })
}

const performRequest = async (
  transport: SafeFetchTransport,
  options: RequestOptions,
  context: RequestContext,
  body: Buffer | undefined,
): Promise<IncomingMessage> => {
  const request = createRequest(transport, options, context.hostname)

  request.once('timeout', () =>
    request.destroy(new SafeFetchError('TIMEOUT', 'timeout', { hostname: context.hostname })),
  )

  return new Promise<IncomingMessage>((resolve, reject) => {
    request.once('response', resolve)
    request.once('error', (error: Error) => reject(toRequestError(error, context)))
    request.once('close', () =>
      reject(
        context.signal.aborted
          ? new SafeFetchError('TIMEOUT', 'timeout', { hostname: context.hostname })
          : new SafeFetchError('REQUEST_FAILED', 'conexão encerrada antes da resposta', {
              hostname: context.hostname,
            }),
      ),
    )

    try {
      request.end(body)
    } catch (cause) {
      request.destroy()
      reject(
        new SafeFetchError('REQUEST_FAILED', 'falha ao enviar corpo', { hostname: context.hostname, cause }),
      )
    }
  })
}

const collectChunks = async (
  iterator: AsyncIterator<Buffer>,
  maxBytes: number,
  context: BodyContext,
  chunks: readonly Buffer[],
  total: number,
): Promise<readonly Buffer[]> => {
  const next = await iterator.next()
  if (next.done === true) return chunks

  const nextTotal = total + next.value.byteLength
  if (nextTotal > maxBytes) {
    await iterator.return?.()
    throw new SafeFetchError('RESPONSE_TOO_LARGE', 'resposta acima do limite', {
      hostname: context.hostname,
      status: context.status,
    })
  }

  return collectChunks(iterator, maxBytes, context, [...chunks, next.value], nextTotal)
}

const readBody = async (
  response: IncomingMessage,
  maxBytes: number,
  context: BodyContext,
): Promise<Buffer> => {
  try {
    const chunks = await collectChunks(response[Symbol.asyncIterator](), maxBytes, context, [], 0)
    return Buffer.concat([...chunks])
  } catch (error) {
    if (error instanceof SafeFetchError) throw error
    if (context.signal.aborted) {
      throw new SafeFetchError('TIMEOUT', 'timeout', { hostname: context.hostname, cause: error })
    }
    throw new SafeFetchError('REQUEST_FAILED', 'falha ao ler resposta', {
      hostname: context.hostname,
      status: context.status,
      cause: error,
    })
  }
}

const readResponse = async (
  response: IncomingMessage,
  context: ResponseContext,
): Promise<Omit<SafeFetchResponse, 'address'>> => {
  const status = response.statusCode ?? 0
  if (status === 0) {
    response.resume()
    throw new SafeFetchError('REQUEST_FAILED', 'resposta sem status HTTP', { hostname: context.hostname })
  }
  if (status >= 300 && status < 400) {
    response.resume()
    throw new SafeFetchError('REDIRECT_BLOCKED', 'redirect não é seguido', {
      hostname: context.hostname,
      status,
    })
  }

  const rawContentType = response.headers['content-type']
  const contentType = typeof rawContentType === 'string' ? normalizeContentType(rawContentType) : null
  const requiresContentType = context.allowedContentTypes.size > 0

  if (requiresContentType && contentType !== null && !context.allowedContentTypes.has(contentType)) {
    response.resume()
    throw new SafeFetchError('CONTENT_TYPE_NOT_ALLOWED', 'content-type não permitido', {
      hostname: context.hostname,
      status,
    })
  }

  const missingContentType =
    requiresContentType &&
    contentType === null &&
    status !== 204 &&
    status !== 205 &&
    response.headers['content-length'] !== '0'

  const body = await readBody(response, context.maxResponseBytes, {
    hostname: context.hostname,
    status,
    signal: context.signal,
  })

  if (missingContentType && body.byteLength > 0) {
    throw new SafeFetchError('CONTENT_TYPE_NOT_ALLOWED', 'content-type ausente', {
      hostname: context.hostname,
      status,
    })
  }

  return { status, headers: response.headers, body }
}

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
    const method = normalizeMethod(options.method, hostname)
    const body = normalizeBody(options.body)
    validateRequestBody(method, body, hostname)

    const headers = prepareHeaders(options.headers, body)
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
    const signal = AbortSignal.timeout(remainingMs)
    const requestOptions: RequestOptions = {
      protocol: 'https:',
      hostname,
      port: url.port === '' ? 443 : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      lookup: createPinnedLookup(chosen),
      servername: isIP(hostname) === 0 ? hostname : undefined,
      rejectUnauthorized: true,
      maxHeaderSize: maxHeaderBytes,
      timeout: Math.min(SAFE_FETCH_CONNECT_TIMEOUT_MS, remainingMs),
      signal,
      ...(factory.ca !== undefined ? { ca: factory.ca } : {}),
    }

    const response = await performRequest(transport, requestOptions, { hostname, signal }, body)
    const result = await readResponse(response, {
      hostname,
      allowedContentTypes,
      maxResponseBytes,
      signal,
    })

    return { ...result, address: chosen.address }
  }
}
