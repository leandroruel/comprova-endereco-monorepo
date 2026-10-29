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
