import { createHash } from 'node:crypto'
import {
  CREDENTIALS_PATH,
  CREDENTIAL_STATUS_PATH,
  CredentialStatusDocumentSchema,
  type CredentialStatusValue,
} from '../schema/status.schema.js'
import { ISSUERS_PATH, IssuerIdentityError, parseIssuerOrigin } from './issuer.service.js'

/**
 * Identificador público da credencial e resolução do status (ADR-0027).
 *
 * O `credential_id` é `base64url(sha256(domínio | issuer.id | validation_id))`:
 * determinístico para o par (issuer, validation), opaco (não expõe o UUID da
 * validation nem o tenant), independente da chave de assinatura e do material
 * físico da evidence. Reemitir a MESMA validation preserva o id — e, portanto,
 * o mesmo status.
 *
 * O `issuer.id` entra no hash de propósito: dois tenants (ou duas origens)
 * nunca compartilham o identificador, mesmo que um `validation_id` se repita.
 */
const CREDENTIAL_ID_DOMAIN = 'comprova:credential:v1'
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

const assertIssuerUrl = (issuerId: string): string => {
  let url: URL
  try {
    url = new URL(issuerId)
  } catch {
    throw new IssuerIdentityError(`issuer id is not a URL: ${issuerId}`)
  }
  if (url.protocol !== 'https:') {
    throw new IssuerIdentityError(`issuer id must be https: ${issuerId}`)
  }
  if (url.search !== '' || url.hash !== '') {
    throw new IssuerIdentityError(`issuer id must not carry query or fragment: ${issuerId}`)
  }
  return issuerId
}

export const credentialIdOf = (issuerId: string, validationId: string): string =>
  createHash('sha256')
    .update(`${CREDENTIAL_ID_DOMAIN}|${assertIssuerUrl(issuerId)}|${validationId}`, 'utf8')
    .digest('base64url')

export const credentialUrlOf = (issuerId: string, credentialId: string): string =>
  `${assertIssuerUrl(issuerId)}/${CREDENTIALS_PATH}/${credentialId}`

export const credentialStatusUrlOf = (issuerId: string, credentialId: string): string =>
  `${credentialUrlOf(issuerId, credentialId)}/${CREDENTIAL_STATUS_PATH}`

/**
 * Resolve o status de uma credencial a partir da URL assinada em
 * `credentialStatus.id`. Deve lançar quando o status não puder ser obtido: o
 * verificador traduz a falha em `STATUS_UNAVAILABLE` (fail closed).
 */
export type CredentialStatusResolver = (statusUrl: string) => Promise<CredentialStatusValue>

export class CredentialStatusResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CredentialStatusResolutionError'
  }
}

export interface HttpCredentialStatusResolverOptions {
  /**
   * Origens de issuer em que o consumidor confia. O status só é buscado sob
   * estas origens; a URL assinada na credencial já amarra o issuer, mas a
   * allowlist impede que um resolver seja usado para buscar uma origem
   * arbitrária.
   */
  readonly trustedIssuerOrigins: readonly string[]
  /** Injetável para testes; default: `fetch` global. */
  readonly fetch?: typeof globalThis.fetch
}

const statusUrlSegmentsOf = (url: URL): readonly string[] =>
  url.pathname.split('/').filter((segment) => segment !== '')

const assertStatusUrlShape = (url: URL): void => {
  const segments = statusUrlSegmentsOf(url)
  if (
    segments.length !== 5 ||
    segments[0] !== ISSUERS_PATH ||
    segments[2] !== CREDENTIALS_PATH ||
    segments[4] !== CREDENTIAL_STATUS_PATH ||
    !CREDENTIAL_ID_PATTERN.test(segments[1] ?? '') ||
    !CREDENTIAL_ID_PATTERN.test(segments[3] ?? '')
  ) {
    throw new CredentialStatusResolutionError(
      `credential status URL is not an issuer status endpoint: ${url.href}`,
    )
  }
}

/**
 * Resolver HTTP concreto do status. Busca exatamente a URL assinada em
 * `credentialStatus.id`, com HTTPS, origem na allowlist, sem redirect/query/
 * fragmento e exigindo o path `/issuers/<escopo>/credentials/<id>/status`.
 *
 * A resposta é `{ "status": "ACTIVE" | "REVOKED" }`; qualquer outra coisa
 * (HTTP não-ok, JSON inválido, status desconhecido, campo extra) é erro e o
 * verificador falha fechado. O status não é assinado: a confiança no valor vem
 * de TLS + origem do issuer, e a URL é coberta pela assinatura da credencial.
 */
export const makeHttpCredentialStatusResolver = (
  options: HttpCredentialStatusResolverOptions,
): CredentialStatusResolver => {
  const trustedOrigins = new Set(options.trustedIssuerOrigins.map(parseIssuerOrigin))
  const doFetch = options.fetch ?? globalThis.fetch

  return async (statusUrl) => {
    let url: URL
    try {
      url = new URL(statusUrl)
    } catch {
      throw new CredentialStatusResolutionError(`credential status is not a URL: ${statusUrl}`)
    }
    if (url.protocol !== 'https:') {
      throw new CredentialStatusResolutionError(`credential status must be https: ${url.origin}`)
    }
    if (url.username !== '' || url.password !== '') {
      throw new CredentialStatusResolutionError('credential status URL must not carry credentials')
    }
    if (url.search !== '' || url.hash !== '') {
      throw new CredentialStatusResolutionError('credential status URL must not carry query or fragment')
    }
    if (!trustedOrigins.has(url.origin)) {
      throw new CredentialStatusResolutionError(`issuer origin is not trusted: ${url.origin}`)
    }
    assertStatusUrlShape(url)

    const response = await doFetch(statusUrl, { redirect: 'error' }).catch((error: unknown) => {
      throw new CredentialStatusResolutionError(
        `failed to fetch the credential status: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    if (response.redirected) {
      throw new CredentialStatusResolutionError('credential status must not be reached by redirect')
    }
    if (!response.ok) {
      throw new CredentialStatusResolutionError(
        `credential status request failed with status ${response.status}`,
      )
    }

    const parsed = CredentialStatusDocumentSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) {
      throw new CredentialStatusResolutionError('credential status document is malformed')
    }
    return parsed.data.status
  }
}

export { CREDENTIAL_ID_PATTERN }
