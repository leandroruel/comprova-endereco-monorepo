import type { KeyObject } from 'node:crypto'
import { DID_CONTEXT_URL, DID_METHOD, DidDocumentSchema, type DidDocument } from '../schema/did.schema.js'
import { MULTIKEY_TYPE, type IssuerVerificationKey } from '../schema/issuer.schema.js'
import {
  ISSUERS_PATH,
  assertKeyId,
  decodeEd25519PublicKeyMultibase,
  encodeEd25519PublicKeyMultibase,
  parseIssuerOrigin,
} from './issuer.service.js'
import { VerificationMethodResolutionError, type VerificationMethodResolver } from './verification.service.js'

/**
 * Identidade DID do issuer e resolução do DID Document (ADR-0028).
 *
 * Este service é puro: não acessa banco, rede nem ambiente. O DID é derivado
 * deterministicamente do `issuer.id` (a mesma origem + o mesmo escopo do
 * tenant), então dois tenants nunca compartilham DID e o mesmo tenant sempre
 * produz o mesmo DID. O DID não contém `tenant_id`, `subject`, CPF/CNPJ,
 * `doc_hmac` nem `validation_id`.
 *
 * O método escolhido é `did:web` (ADR-0020 §3 / ADR-0024 §2 já o antecipavam): a
 * resolução é `GET <origem>/issuers/<escopo>/did.json`, sobre a origem HTTPS que
 * o projeto controla. Não há resolução DID distribuída, ledger nem blockchain.
 */

export class DidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DidError'
  }
}

const DID_PREFIX = `did:${DID_METHOD}:`
/** Segmentos do path de um issuer do Comprova: `issuers/<escopo>`. */
const ISSUER_PATH_SEGMENTS = 2
/** Host de `did:web`: domínio (com porta opcional), sem `%`-encoding residual. */
const DID_HOST_PATTERN = /^[a-z0-9.-]+(:\d+)?$/i

interface IssuerUrlParts {
  readonly origin: string
  readonly host: string
  readonly scope: string
}

/**
 * Interpreta um `issuer.id` do Comprova (`<origem>/issuers/<escopo>`).
 *
 * Rejeita query/fragmento/credenciais e qualquer path que não seja o de um
 * issuer — o DID só é derivado de uma identidade que a API realmente publica.
 */
const issuerUrlParts = (issuerId: string): IssuerUrlParts => {
  let url: URL
  try {
    url = new URL(issuerId)
  } catch {
    throw new DidError(`issuer id is not a URL: ${issuerId}`)
  }
  if (url.protocol !== 'https:') {
    throw new DidError(`issuer id must be https (got ${url.protocol}): ${issuerId}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new DidError(`issuer id must not carry credentials: ${issuerId}`)
  }
  if (url.search !== '' || url.hash !== '') {
    throw new DidError(`issuer id must not carry query or fragment: ${issuerId}`)
  }
  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  const scope = segments[1]
  if (segments.length !== ISSUER_PATH_SEGMENTS || segments[0] !== ISSUERS_PATH || scope === undefined) {
    throw new DidError(`issuer id has no Comprova issuer mapping: ${issuerId}`)
  }
  return { origin: url.origin, host: url.host, scope }
}

/**
 * DID determinístico do issuer: `did:web:<host>:issuers:<escopo>`.
 *
 * O `host` (com porta, se houver) é percent-encoded como `%3A`, conforme o
 * método `did:web`; o path do issuer entra como segmentos separados por `:`.
 * Mesma entrada → mesmo DID; tenants/origens diferentes → DIDs diferentes.
 */
export const didOfIssuer = (issuerId: string): string => {
  const { host, scope } = issuerUrlParts(issuerId)
  const hostSegment = host.replace(/:/g, '%3A')
  return `${DID_PREFIX}${hostSegment}:${ISSUERS_PATH}:${scope}`
}

/**
 * URL do DID Document, resolvida pelo método `did:web`:
 *
 *   did:web:<host>:issuers:<escopo>  →  https://<host>/issuers/<escopo>/did.json
 *   did:web:<host>                   →  https://<host>/.well-known/did.json
 *
 * O fragmento (quando presente) é ignorado: o documento é sempre da identidade,
 * não de um método de verificação. Segmentos de path com `%`-encoding são
 * decodificados e validados; barras ou `..` injetados são recusados.
 */
export const didDocumentUrlOf = (did: string): string => {
  const bare = did.split('#')[0] ?? ''
  if (!bare.startsWith(DID_PREFIX)) {
    throw new DidError(`not a did:${DID_METHOD} identifier: ${did}`)
  }
  const parts = bare.slice(DID_PREFIX.length).split(':')
  const hostPart = parts[0] ?? ''
  if (hostPart === '') {
    throw new DidError(`did:${DID_METHOD} identifier has no host: ${did}`)
  }
  const host = decodePart(hostPart, did)
  if (!DID_HOST_PATTERN.test(host) || host.includes('..')) {
    throw new DidError(`did:${DID_METHOD} host is not a valid domain: ${did}`)
  }
  const pathSegments = parts.slice(1).map((segment) => {
    const decoded = decodePart(segment, did)
    if (decoded === '' || decoded === '.' || decoded === '..' || /[/\\]/.test(decoded)) {
      throw new DidError(`did:${DID_METHOD} path segment is not safe: ${did}`)
    }
    return decoded
  })
  if (pathSegments.length === 0) return `https://${host}/.well-known/did.json`
  return `https://${host}/${pathSegments.join('/')}/did.json`
}

const decodePart = (value: string, did: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new DidError(`did:${DID_METHOD} identifier is not percent-encoded correctly: ${did}`)
  }
}

/**
 * Identificador do método de verificação dentro do DID:
 * `<did>#<keyId>`. Mesmo `issuer + key_id` → mesmo id; é o que liga
 * `proof.verificationMethod` (URL HTTPS) ao DID Document pelo fragmento.
 */
export const didVerificationMethodOf = (did: string, keyId: string): string => {
  if (!did.startsWith(DID_PREFIX)) {
    throw new DidError(`not a did:${DID_METHOD} identifier: ${did}`)
  }
  return `${did}#${assertKeyId(keyId)}`
}

/**
 * Materializa o DID Document a partir do DID, da URL do issuer e das chaves
 * públicas publicadas. Puro: não lê banco nem ambiente.
 *
 * `alsoKnownAs` liga o DID à URL HTTPS do issuer (a MESMA identidade que a
 * credencial carrega em `issuer`); `verificationMethod` e `assertionMethod`
 * listam TODAS as chaves publicadas, preservando o comportamento de rotação
 * (`#key-1`, `#key-2`), e cada método tem `controller` = DID.
 */
export const didDocumentOf = (
  did: string,
  issuerUrl: string,
  methods: readonly IssuerVerificationKey[],
): DidDocument => {
  const methodIds = methods.map(({ keyId }) => didVerificationMethodOf(did, keyId))
  return {
    '@context': [DID_CONTEXT_URL],
    id: did,
    alsoKnownAs: [issuerUrl],
    verificationMethod: methods.map(({ keyId, publicKey }) => ({
      id: didVerificationMethodOf(did, keyId),
      type: MULTIKEY_TYPE,
      controller: did,
      publicKeyMultibase: encodeEd25519PublicKeyMultibase(publicKey),
    })),
    assertionMethod: methodIds,
  }
}

export interface HttpDidResolverOptions {
  /**
   * Origens de issuer em que o consumidor confia. O DID é derivado do
   * `verificationMethod` (URL HTTPS) da credencial, e só origens desta lista
   * são resolvidas — uma credencial não consegue apontar o resolver para uma
   * origem arbitrária.
   */
  readonly trustedIssuerOrigins: readonly string[]
  /** Injetável para testes; default: `fetch` global. */
  readonly fetch?: typeof globalThis.fetch
}

/**
 * Resolver HTTP do DID Document (`did:web`), plugável no MESMO ponto de
 * verificação do `makeHttpIssuerResolver` (`VerificationMethodResolver`).
 *
 * Dado o `proof.verificationMethod` (`<issuer.id>#<keyId>`), ele:
 *
 *  1. exige HTTPS, origem na allowlist e URL sem query;
 *  2. deriva o DID do issuer e sua URL de resolução (`.../did.json`);
 *  3. busca o documento sem seguir redirect;
 *  4. valida forma + `@context` + `id` == DID derivado;
 *  5. exige que `alsoKnownAs` contenha a URL HTTPS do issuer (mesma entidade);
 *  6. exige que `assertionMethod` autorize o método do fragmento;
 *  7. localiza o `verificationMethod` (controller == DID) e decodifica a chave.
 *
 * Devolve o id ORIGINAL do método (`<issuer.id>#<keyId>`, HTTPS), de modo que o
 * binding exato de `verifyCredential` continue valendo. O verificador segue sem
 * banco, Redis, S3, Temporal ou chave privada.
 */
export const makeHttpDidResolver = (options: HttpDidResolverOptions): VerificationMethodResolver => {
  const trustedOrigins = new Set(options.trustedIssuerOrigins.map(parseIssuerOrigin))
  const doFetch = options.fetch ?? globalThis.fetch

  return async (verificationMethod) => {
    let url: URL
    try {
      url = new URL(verificationMethod)
    } catch {
      throw new VerificationMethodResolutionError(`verification method is not a URL: ${verificationMethod}`)
    }
    if (url.protocol !== 'https:') {
      throw new VerificationMethodResolutionError(`verification method must be https: ${url.origin}`)
    }
    if (url.search !== '') {
      throw new VerificationMethodResolutionError('verification method must not carry a query')
    }
    if (!trustedOrigins.has(url.origin)) {
      throw new VerificationMethodResolutionError(`issuer origin is not trusted: ${url.origin}`)
    }
    const issuerUrl = `${url.origin}${url.pathname}`
    const keyId = url.hash.startsWith('#') ? url.hash.slice(1) : ''
    if (keyId === '') {
      throw new VerificationMethodResolutionError('verification method has no key fragment')
    }

    let did: string
    let documentUrl: string
    let methodId: string
    try {
      did = didOfIssuer(issuerUrl)
      documentUrl = didDocumentUrlOf(did)
      methodId = didVerificationMethodOf(did, keyId)
    } catch (error) {
      throw new VerificationMethodResolutionError(error instanceof Error ? error.message : String(error))
    }

    // `redirect: 'error'` impede que a allowlist seja contornada por um 3xx; a
    // checagem de `redirected` cobre respostas 2xx que passaram por redirect.
    const response = await doFetch(documentUrl, { redirect: 'error' }).catch((error: unknown) => {
      throw new VerificationMethodResolutionError(
        `failed to fetch the DID document: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    if (response.redirected) {
      throw new VerificationMethodResolutionError('DID document must not be reached by redirect')
    }
    if (!response.ok) {
      throw new VerificationMethodResolutionError(
        `DID document request failed with status ${response.status}`,
      )
    }

    const parsed = DidDocumentSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) {
      throw new VerificationMethodResolutionError('DID document is malformed')
    }
    const document = parsed.data
    if (!document['@context'].includes(DID_CONTEXT_URL)) {
      throw new VerificationMethodResolutionError('DID document does not declare the DID context')
    }
    if (document.id !== did) {
      throw new VerificationMethodResolutionError('DID document id does not match the issuer DID')
    }
    if (!document.alsoKnownAs.includes(issuerUrl)) {
      throw new VerificationMethodResolutionError('DID document does not acknowledge the issuer URL')
    }
    if (!document.assertionMethod.includes(methodId)) {
      throw new VerificationMethodResolutionError('DID document does not authorize the key for assertion')
    }
    const method = document.verificationMethod.find((entry) => entry.id === methodId)
    if (method === undefined) {
      throw new VerificationMethodResolutionError(`verification method not found: ${methodId}`)
    }
    if (method.controller !== did) {
      throw new VerificationMethodResolutionError('verification method controller is not the issuer DID')
    }

    const publicKey: KeyObject = (() => {
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
