import type { KeyObject } from 'node:crypto'
import { IssuerKeyDocumentSchema } from './issuer-key.js'
import { parseIssuerOrigin } from './issuer.js'
import { decodeEd25519PublicKeyMultibase } from './public-key.js'
import { verifyCredential, type CredentialVerificationFailure } from './verifier.js'

/**
 * Resolução de chave pública do issuer (FASE 13).
 *
 * `verifyCredential` continua puro e sem rede: ele recebe o método de verificação
 * confiável já resolvido (`{ id, publicKey }`). A resolução é uma dependência
 * EXPLÍCITA desta camada — uma função que o consumidor fornece —, de modo que a
 * biblioteca segue utilizável fora da API (sem Fastify, sem PostgreSQL, sem
 * Redis, sem S3).
 */

/** Método de verificação resolvido: a chave e o id ao qual ela está vinculada. */
export interface ResolvedVerificationMethod {
  readonly id: string
  readonly publicKey: KeyObject
}

/**
 * Resolve um `proof.verificationMethod` no material público que o verifica.
 * Deve lançar quando o método não puder ser resolvido.
 */
export type VerificationMethodResolver = (verificationMethod: string) => Promise<ResolvedVerificationMethod>

export class VerificationMethodResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VerificationMethodResolutionError'
  }
}

/**
 * Falha de verificação com resolução: as mesmas razões de `verifyCredential`
 * mais `VERIFICATION_METHOD_UNRESOLVED` (o método não pôde ser resolvido).
 */
export type IssuerVerificationFailure = CredentialVerificationFailure | 'VERIFICATION_METHOD_UNRESOLVED'

export type IssuerVerificationResult =
  { readonly valid: true } | { readonly valid: false; readonly reason: IssuerVerificationFailure }

export interface VerifyFromIssuerOptions {
  /** Issuer esperado pelo consumidor. Quando informado, precisa ser o `issuer` da credencial. */
  readonly expectedIssuerId?: string
}

const issuerAndMethodOf = (
  credential: unknown,
): { readonly issuer: string; readonly verificationMethod: string } | null => {
  if (credential === null || typeof credential !== 'object' || Array.isArray(credential)) return null
  const raw = credential as Record<string, unknown>
  const issuer = raw['issuer']
  if (typeof issuer !== 'string' || issuer === '') return null
  const proof = raw['proof']
  if (proof === null || typeof proof !== 'object' || Array.isArray(proof)) return null
  const verificationMethod = (proof as Record<string, unknown>)['verificationMethod']
  if (typeof verificationMethod !== 'string' || verificationMethod === '') return null
  return { issuer, verificationMethod }
}

/**
 * Verificação independente com resolução de chave: valida a forma mínima da
 * credencial, amarra o `verificationMethod` ao `issuer` declarado, resolve o
 * material público pelo resolver injetado e delega a verificação criptográfica
 * a `verifyCredential`.
 *
 * Segurança do resolver (§7): a chave resolvida só vale para o método EXATO que
 * a credencial declara (`resolved.id === verificationMethod`) e esse método tem
 * de pertencer ao issuer declarado (`<issuer>#<fragmento>`). A resolução é
 * injetada — e `makeHttpIssuerResolver` acrescenta a allowlist de origens —,
 * então uma credencial não consegue escolher uma chave arbitrária controlada por
 * um atacante.
 */
export const verifyCredentialFromIssuer = async (
  credential: unknown,
  resolver: VerificationMethodResolver,
  options: VerifyFromIssuerOptions = {},
): Promise<IssuerVerificationResult> => {
  const ids = issuerAndMethodOf(credential)
  if (ids === null) return { valid: false, reason: 'MALFORMED_CREDENTIAL' }
  const { issuer, verificationMethod } = ids

  // Vínculo estrutural ANTES de resolver: o método precisa pertencer ao issuer
  // declarado. Sem isto, a credencial escolheria de quem buscar a chave.
  const issuerFragment = `${issuer}#`
  if (!verificationMethod.startsWith(issuerFragment) || verificationMethod.length === issuerFragment.length) {
    return { valid: false, reason: 'VERIFICATION_METHOD_MISMATCH' }
  }
  if (options.expectedIssuerId !== undefined && issuer !== options.expectedIssuerId) {
    return { valid: false, reason: 'ISSUER_MISMATCH' }
  }

  const resolved = await resolver(verificationMethod).catch(() => null)
  if (resolved === null) return { valid: false, reason: 'VERIFICATION_METHOD_UNRESOLVED' }
  if (resolved.id !== verificationMethod) {
    return { valid: false, reason: 'VERIFICATION_METHOD_MISMATCH' }
  }

  return verifyCredential(credential, {
    trusted: { id: resolved.id, publicKey: resolved.publicKey },
    expectedIssuerId: issuer,
  })
}

export interface HttpIssuerResolverOptions {
  /**
   * Origens de issuer em que o consumidor confia. Só métodos sob estas origens
   * são buscados: é o que impede a credencial de apontar para uma URL arbitrária.
   */
  readonly trustedIssuerOrigins: readonly string[]
  /** Injetável para testes; default: `fetch` global. */
  readonly fetch?: typeof globalThis.fetch
}

const urlOf = (value: string): URL => {
  try {
    return new URL(value)
  } catch {
    throw new VerificationMethodResolutionError(`verification method is not a URL: ${value}`)
  }
}

/**
 * Resolver HTTP concreto (FASE 13): busca `GET <issuer.id>` (o documento de
 * chave do issuer) e devolve a chave do método pedido.
 *
 * Ele só busca origens declaradas confiáveis (`trustedIssuerOrigins`) e exige
 * HTTPS; um documento cujo `id` não corresponde ao issuer pedido, que não lista
 * o método, ou cujo `controller` não é o issuer, é recusado. Nada de chave
 * privada: o documento carrega apenas `publicKeyMultibase`.
 */
export const makeHttpIssuerResolver = (options: HttpIssuerResolverOptions): VerificationMethodResolver => {
  const trustedOrigins = new Set(options.trustedIssuerOrigins.map(parseIssuerOrigin))
  const doFetch = options.fetch ?? globalThis.fetch

  return async (verificationMethod) => {
    const url = urlOf(verificationMethod)
    if (url.protocol !== 'https:') {
      throw new VerificationMethodResolutionError(`verification method must be https: ${url.origin}`)
    }
    if (url.search !== '') {
      throw new VerificationMethodResolutionError(`issuer key document URL must not carry a query`)
    }
    if (!trustedOrigins.has(url.origin)) {
      throw new VerificationMethodResolutionError(`issuer origin is not trusted: ${url.origin}`)
    }
    const documentUrl = `${url.origin}${url.pathname}`

    // `redirect: 'error'` impede que a allowlist seja contornada por um 3xx: o
    // fetch precisa ir à origem confiável exata. A checagem de `redirected`
    // cobre respostas que chegaram por redirecionamento com status 2xx.
    const response = await doFetch(documentUrl, { redirect: 'error' }).catch((error: unknown) => {
      throw new VerificationMethodResolutionError(
        `failed to fetch the issuer key document: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    if (response.redirected) {
      throw new VerificationMethodResolutionError('issuer key document must not be reached by redirect')
    }
    if (!response.ok) {
      throw new VerificationMethodResolutionError(
        `issuer key document request failed with status ${response.status}`,
      )
    }

    const parsed = IssuerKeyDocumentSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) {
      throw new VerificationMethodResolutionError('issuer key document is malformed')
    }
    if (parsed.data.id !== documentUrl) {
      throw new VerificationMethodResolutionError(
        'issuer key document id does not match the requested issuer',
      )
    }
    const method = parsed.data.verificationMethod.find((entry) => entry.id === verificationMethod)
    if (method === undefined) {
      throw new VerificationMethodResolutionError(`verification method not found: ${verificationMethod}`)
    }
    if (method.controller !== parsed.data.id) {
      throw new VerificationMethodResolutionError('verification method controller is not the issuer')
    }

    const publicKey = ((): KeyObject => {
      try {
        return decodeEd25519PublicKeyMultibase(method.publicKeyMultibase)
      } catch (error) {
        throw new VerificationMethodResolutionError(
          `issuer published an invalid public key: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })()
    return { id: verificationMethod, publicKey }
  }
}
