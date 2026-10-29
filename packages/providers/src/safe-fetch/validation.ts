import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { SafeFetchError } from './errors.js'
import type { SafeFetchReason } from './errors.js'
import type { ResolvedAddress, SafeFetchResolver } from './types.js'

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

export const normalizeHostname = (hostname: string): string =>
  hostname
    .replace(/^\[|\]$/g, '')
    .trim()
    .toLowerCase()

export const normalizeContentType = (value: string): string =>
  (value.split(';')[0] ?? '').trim().toLowerCase()

const parseIpAddress = (address: string): ipaddr.IPv4 | ipaddr.IPv6 | null => {
  try {
    return ipaddr.parse(address.trim())
  } catch {
    return null
  }
}

/**
 * Classifica um IP literal. Retorna `null` somente para unicast global.
 * IPv4 mapeado em IPv6 é convertido antes da classificação.
 */
export const classifyIpAddress = (address: string): SafeFetchReason | null => {
  const parsed = parseIpAddress(address)
  if (parsed === null) return 'RESERVED_IP'

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

const parseUrl = (raw: string): URL => {
  try {
    return new URL(raw)
  } catch (cause) {
    throw new SafeFetchError('INVALID_URL', 'URL inválida', { cause })
  }
}

export const parseExternalUrl = (raw: string): URL => {
  const url = parseUrl(raw)

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

const normalizeHeaderEntry = ([key, value]: readonly [string, string]): readonly [string, string] => {
  const name = key.toLowerCase()
  if (FORBIDDEN_HEADERS.has(name)) {
    throw new SafeFetchError('INVALID_REQUEST', `header não permitido: ${name}`)
  }
  if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
    throw new SafeFetchError('INVALID_REQUEST', 'header inválido')
  }
  return [name, value]
}

const normalizeHeaders = (
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(headers ?? {}).map(normalizeHeaderEntry))

export const prepareHeaders = (
  headers: Readonly<Record<string, string>> | undefined,
  body: Buffer | undefined,
): Readonly<Record<string, string>> => {
  const normalized = normalizeHeaders(headers)
  const withLength =
    body === undefined ? normalized : { ...normalized, 'content-length': String(body.byteLength) }
  return withLength['accept-encoding'] === undefined
    ? { ...withLength, 'accept-encoding': 'identity' }
    : withLength
}

export const normalizeAllowedContentTypes = (values: readonly string[] | undefined): ReadonlySet<string> =>
  new Set((values ?? []).map(normalizeContentType).filter((value) => value !== ''))

export const clamp = (value: number | undefined, min: number, max: number, fallback: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export const defaultResolve: SafeFetchResolver = async (hostname) => {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true })
  return addresses.map(({ address }) => {
    const family = isIP(address)
    if (family !== 4 && family !== 6) {
      throw new SafeFetchError('HOST_RESOLUTION_FAILED', 'resolver devolveu endereço inválido', { hostname })
    }
    return { address, family }
  })
}

const validateResolvedAddress = (hostname: string, candidate: ResolvedAddress): ResolvedAddress => {
  const family = isIP(candidate.address)
  if (family !== 4 && family !== 6) {
    throw new SafeFetchError('HOST_RESOLUTION_FAILED', 'resolver devolveu endereço inválido', { hostname })
  }

  const reason = classifyIpAddress(candidate.address)
  if (reason !== null) {
    throw new SafeFetchError(reason, 'destino não permitido', { hostname })
  }

  return { address: candidate.address, family }
}

const resolveAndValidate = async (
  hostname: string,
  resolve: SafeFetchResolver,
): Promise<readonly ResolvedAddress[]> => {
  const literalFamily = isIP(hostname)
  const addresses: readonly ResolvedAddress[] =
    literalFamily === 4 || literalFamily === 6
      ? [{ address: hostname, family: literalFamily }]
      : await resolve(hostname).catch((cause: unknown) => {
          throw new SafeFetchError('HOST_RESOLUTION_FAILED', 'falha ao resolver host', { hostname, cause })
        })

  if (addresses.length === 0) {
    throw new SafeFetchError('HOST_RESOLUTION_FAILED', 'host sem endereço', { hostname })
  }

  return addresses.map((candidate) => validateResolvedAddress(hostname, candidate))
}

const rejectAfterTimeout = (hostname: string, timeoutMs: number): Promise<never> => {
  const signal = AbortSignal.timeout(timeoutMs)
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(new SafeFetchError('TIMEOUT', 'timeout ao resolver host', { hostname })),
      { once: true },
    )
  })
}

export const resolveWithTimeout = async (
  hostname: string,
  resolve: SafeFetchResolver,
  timeoutMs: number,
): Promise<readonly ResolvedAddress[]> =>
  Promise.race([resolveAndValidate(hostname, resolve), rejectAfterTimeout(hostname, timeoutMs)])
