import type { FiscalSourceId, VerificationEnvironment } from '@comprova/core'
import type { SafeFetch, SafeFetchOptions, SafeFetchResponse } from '../safe-fetch.js'

/**
 * F2.1 — allowlist server-side de endpoints fiscais.
 *
 * O adapter NUNCA busca a URL do QR fornecido pelo usuário. Ele identifica
 * `(source, issuer, environment)` e resolve a URL de consulta nesta allowlist,
 * versionada em código. A lista nasce vazia: nenhum autorizador real é
 * habilitado nesta etapa (F2.2).
 *
 * A chamada efetiva é delegada à guarda única `safeExternalFetch`, que valida
 * DNS/IP, bloqueia loopback/RFC1918/link-local/metadata, fixa o IP, recusa
 * redirect e aplica timeout/limites/content-type.
 */

export interface FiscalEndpoint {
  readonly source: FiscalSourceId
  readonly issuer: string
  readonly environment: VerificationEnvironment
  readonly url: string
}

export interface FiscalEndpointRef {
  readonly source: FiscalSourceId
  readonly issuer: string | null
  readonly environment: VerificationEnvironment
}

export interface FiscalEndpointAllowlist {
  readonly resolve: (ref: FiscalEndpointRef) => FiscalEndpoint | null
}

export class FiscalEndpointNotAllowedError extends Error {
  readonly reason = 'ENDPOINT_NOT_ALLOWED'

  constructor(
    readonly source: FiscalSourceId,
    readonly issuer: string | null,
  ) {
    super('endpoint fiscal fora da allowlist')
    this.name = 'FiscalEndpointNotAllowedError'
  }
}

const normalizeIssuer = (issuer: string): string => issuer.trim().toLowerCase()

const keyOf = (source: FiscalSourceId, issuer: string, environment: VerificationEnvironment): string =>
  `${source}|${normalizeIssuer(issuer)}|${environment}`

const assertEndpointUrl = (endpoint: FiscalEndpoint): void => {
  let url: URL
  try {
    url = new URL(endpoint.url)
  } catch {
    throw new Error(`endpoint fiscal inválido: ${endpoint.source}/${endpoint.issuer}`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(`endpoint fiscal exige https: ${endpoint.source}/${endpoint.issuer}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`endpoint fiscal não aceita credenciais: ${endpoint.source}/${endpoint.issuer}`)
  }
}

export const makeFiscalEndpointAllowlist = (entries: readonly FiscalEndpoint[]): FiscalEndpointAllowlist => {
  const index = new Map<string, FiscalEndpoint>()
  for (const entry of entries) {
    assertEndpointUrl(entry)
    const key = keyOf(entry.source, entry.issuer, entry.environment)
    if (index.has(key)) {
      throw new Error(`endpoint fiscal duplicado: ${entry.source}/${entry.issuer}/${entry.environment}`)
    }
    index.set(key, entry)
  }

  return {
    resolve: (ref) =>
      ref.issuer === null ? null : (index.get(keyOf(ref.source, ref.issuer, ref.environment)) ?? null),
  }
}

/** F2.1: allowlist vazia. Nenhuma consulta fiscal real é possível. */
export const FISCAL_ENDPOINT_ALLOWLIST = makeFiscalEndpointAllowlist([])

export interface SafeFetchFiscalEndpointInput {
  readonly allowlist: FiscalEndpointAllowlist
  readonly ref: FiscalEndpointRef
  readonly safeFetch: SafeFetch
  readonly options?: SafeFetchOptions
}

/**
 * Resolve a URL na allowlist e delega para a guarda existente. Não existe
 * parâmetro de URL vinda do documento/usuário nesta função.
 */
export const safeFetchFiscalEndpoint = async (
  input: SafeFetchFiscalEndpointInput,
): Promise<SafeFetchResponse> => {
  const endpoint = input.allowlist.resolve(input.ref)
  if (endpoint === null) {
    throw new FiscalEndpointNotAllowedError(input.ref.source, input.ref.issuer)
  }
  return input.safeFetch(endpoint.url, input.options)
}
