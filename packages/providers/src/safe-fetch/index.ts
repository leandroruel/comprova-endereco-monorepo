import { createSafeExternalFetch } from './http.js'

export { SAFE_FETCH_REASONS, SafeFetchError } from './errors.js'
export type { SafeFetchErrorOptions, SafeFetchReason } from './errors.js'
export { createSafeExternalFetch } from './http.js'
export {
  SAFE_FETCH_CONNECT_TIMEOUT_MS,
  SAFE_FETCH_DEFAULT_MAX_HEADER_BYTES,
  SAFE_FETCH_DEFAULT_MAX_RESPONSE_BYTES,
  SAFE_FETCH_DEFAULT_TIMEOUT_MS,
  SAFE_FETCH_MAX_REQUEST_BYTES,
} from './types.js'
export type {
  ResolvedAddress,
  SafeFetch,
  SafeFetchFactoryOptions,
  SafeFetchOptions,
  SafeFetchResolver,
  SafeFetchResponse,
  SafeFetchTransport,
} from './types.js'
export { classifyIpAddress, isSafeExternalUrl } from './validation.js'

/** Instância de produção: sem injeção de resolver, transporte ou CA. */
export const safeExternalFetch = createSafeExternalFetch()
