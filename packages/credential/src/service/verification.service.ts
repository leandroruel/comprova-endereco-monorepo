import type { KeyObject } from 'node:crypto'
import {
  SecuredVerifiableCredentialSchema,
  VC_CONTEXT_URL,
  VERIFIABLE_CREDENTIAL_TYPE,
  type SecuredVerifiableCredential,
} from '../schema/credential.schema.js'
import { IssuerKeyDocumentSchema } from '../schema/issuer.schema.js'
import { ASSERTION_METHOD, type DataIntegrityFailure } from '../schema/proof.schema.js'
import { CREDENTIALS_PATH, CREDENTIAL_STATUS_PATH } from '../schema/status.schema.js'
import { verifyDataIntegrityProof } from './proof.service.js'
import { evidenceSetHashOfCredential } from './assertion.service.js'
import { observationOfEvidence } from './credential.service.js'
import { decodeEd25519PublicKeyMultibase, parseIssuerOrigin, wellKnownIssuerUrlOf } from './issuer.service.js'
import { CREDENTIAL_ID_PATTERN, type CredentialStatusResolver } from './status.service.js'

/**
 * Verificação independente da credencial (FASE 11/13).
 *
 * `verifyCredentialIntegrity` é puro e sem rede: recebe a credencial e o método
 * de verificação confiável já resolvido (`{ id, publicKey }`). A resolução é uma
 * dependência EXPLÍCITA (`VerificationMethodResolver`), de modo que a
 * biblioteca segue utilizável fora da API (sem Fastify, sem PostgreSQL, sem
 * Redis, sem S3).
 */

export type CredentialVerificationFailure =
  | 'MALFORMED_CREDENTIAL'
  | 'UNSUPPORTED_CREDENTIAL'
  | 'UNSUPPORTED_CRYPTOSUITE'
  | 'ISSUER_MISMATCH'
  | 'VERIFICATION_METHOD_MISMATCH'
  | 'PROOF_PURPOSE_MISMATCH'
  | 'INVALID_TIMESTAMP'
  | 'NOT_YET_VALID'
  | 'EXPIRED'
  | 'EVIDENCE_SET_MISMATCH'
  | 'INVALID_SIGNATURE'

/**
 * O que foi efetivamente checado. `integrity` cobre forma, vínculo
 * issuer↔método, binding de evidências e assinatura; `time` só sai de
 * `not_checked` quando o consumidor informa `now`; `status` é sempre
 * `not_checked` aqui — revogação é responsabilidade de
 * `verifyCredentialFromIssuer`/do consumidor (ADR-0024 §6).
 */
export interface CredentialVerificationChecks {
  readonly integrity: 'valid' | 'invalid' | 'not_checked'
  readonly time: 'valid' | 'not_yet_valid' | 'expired' | 'not_checked'
  readonly status: 'not_checked'
}

const checksOf = (
  integrity: CredentialVerificationChecks['integrity'],
  time: CredentialVerificationChecks['time'] = 'not_checked',
): CredentialVerificationChecks => ({ integrity, time, status: 'not_checked' })

export type CredentialVerificationResult =
  | { readonly valid: true; readonly checked: CredentialVerificationChecks }
  | {
      readonly valid: false
      readonly reason: CredentialVerificationFailure
      readonly checked: CredentialVerificationChecks
    }

/**
 * Método de verificação em que o consumidor confia: a chave pública **e** o
 * identificador do método ao qual ela está vinculada
 * (`<issuer>#<keyId>`, como em `verificationMethodOf`).
 *
 * A identidade é obrigatória: um `KeyObject` avulso não declara em QUEM se está
 * confiando, e aceitar só a chave deixaria a credencial escolher o
 * `verificationMethod` que quer ser (integridade criptográfica ≠ confiança na
 * chave do issuer — ADR-0024 §6).
 */
export interface TrustedVerificationMethod {
  readonly id: string
  readonly publicKey: KeyObject
}

export interface VerifierOptions {
  /** Método de verificação confiável (obrigatório; ver `TrustedVerificationMethod`). */
  readonly trusted: TrustedVerificationMethod
  /**
   * Issuer esperado. Quando informado, precisa ser exatamente o `issuer` da
   * credencial; quando omitido, o issuer é o que o `trusted.id` já delimita.
   */
  readonly expectedIssuerId?: string
  /**
   * Instante a usar na checagem TEMPORAL. Quando omitido, o tempo NÃO é
   * checado (`checked.time = 'not_checked'`): `verifyCredentialIntegrity` não
   * inventa um relógio. Quando informado, uma credencial ainda não iniciada é
   * `NOT_YET_VALID` e uma já encerrada é `EXPIRED` (a janela é
   * `[validFrom, validUntil)`).
   */
  readonly now?: Date
}

const proofFailure = (reason: DataIntegrityFailure): CredentialVerificationFailure => {
  switch (reason) {
    case 'UNSUPPORTED_CRYPTOSUITE':
      return 'UNSUPPORTED_CRYPTOSUITE'
    case 'PROOF_PURPOSE_MISMATCH':
      return 'PROOF_PURPOSE_MISMATCH'
    case 'INVALID_SIGNATURE':
      return 'INVALID_SIGNATURE'
    case 'MALFORMED_PROOF':
    case 'PROOF_CONTEXT_MISMATCH':
    case 'INVALID_PROOF_VALUE':
      return 'MALFORMED_CREDENTIAL'
  }
}

const timestampOf = (value: string): number | null => {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * O `id` da credencial é `<issuer>/credentials/<credentialId>`; o status é
 * `<id>/status`. A checagem é estrutural (não busca nada): ela impede que uma
 * credencial assinada aponte o status para outro issuer/tenant. Um documento
 * legado sem `id`/`credentialStatus` continua verificável criptograficamente;
 * quem exige status é `verifyCredentialFromIssuer` (fail closed).
 */
const credentialIdFromUrl = (issuer: string, credentialUrl: string): string | null => {
  const prefix = `${issuer}/${CREDENTIALS_PATH}/`
  if (!credentialUrl.startsWith(prefix)) return null
  const credentialId = credentialUrl.slice(prefix.length)
  return CREDENTIAL_ID_PATTERN.test(credentialId) ? credentialId : null
}

const isCredentialStatusBindingValid = (secured: SecuredVerifiableCredential): boolean => {
  if (secured.id !== undefined && credentialIdFromUrl(secured.issuer, secured.id) === null) {
    return false
  }
  if (secured.credentialStatus === undefined) return true
  if (secured.id === undefined) return false
  return secured.credentialStatus.id === `${secured.id}/${CREDENTIAL_STATUS_PATH}`
}

/**
 * Verificador independente (FASE 11). Recebe apenas a credencial (JSON já
 * parseado) e o método de verificação confiável. NÃO acessa PostgreSQL, Redis,
 * Temporal, S3 nem a API: a integridade e a assinatura são verificadas só com o
 * material da credencial.
 *
 * O que é verificado, nesta ordem:
 *  1. forma do documento (VC 2.0 + extensões Comprova);
 *  2. `@context[0]` e `type` de uma Verifiable Credential;
 *  3. expectativa de issuer (quando fornecida);
 *  4. coerência estrutural `verificationMethod ↔ issuer` declarado (§5.9) e
 *     vínculo com o método confiável: o `verificationMethod` precisa ser
 *     EXATAMENTE `options.trusted.id` (§4);
 *  5. a janela de validade (`validFrom` < `validUntil`, não vazia) e, quando
 *     `now` é informado, o instante contra a janela;
 *  6. o binding do conjunto de evidências (recomputado a partir da própria
 *     credencial — nunca do material físico);
 *  7. o proof Data Integrity `eddsa-jcs-2022` sobre o documento CRU (o JSON
 *     recebido, sem o `proof`), com a chave pública confiável, exigindo
 *     `proofPurpose: assertionMethod`;
 *  8. o binding estrutural do status: `id` pertence ao issuer e
 *     `credentialStatus.id` é exatamente `<id>/status` (ADR-0027).
 *
 * Escopo: este verificador cobre integridade criptográfica, o vínculo entre a
 * chave confiável e a identidade declarada e o binding do ponteiro de status.
 * Ele NÃO resolve o status (`ACTIVE`/`REVOKED`) — isso exige rede e é feito por
 * `verifyCredentialFromIssuer` com um `CredentialStatusResolver`. Ele também
 * NÃO decide validade temporal da credencial por conta própria: só faz isso
 * quando o consumidor informa `now` (o resultado diz exatamente o que foi
 * checado). A legitimidade do issuer continua sendo uma escolha de `trusted`
 * (ADR-0024 §6).
 */
export const verifyCredentialIntegrity = (
  credential: unknown,
  options: VerifierOptions,
): CredentialVerificationResult => {
  if (credential === null || typeof credential !== 'object' || Array.isArray(credential)) {
    return {
      valid: false,
      reason: 'MALFORMED_CREDENTIAL',
      checked: checksOf('not_checked'),
    }
  }
  const raw = credential as Record<string, unknown>

  const parsed = SecuredVerifiableCredentialSchema.safeParse(raw)
  if (!parsed.success) {
    return { valid: false, reason: 'MALFORMED_CREDENTIAL', checked: checksOf('not_checked') }
  }
  const secured = parsed.data

  if (secured['@context'][0] !== VC_CONTEXT_URL || !secured.type.includes(VERIFIABLE_CREDENTIAL_TYPE)) {
    return { valid: false, reason: 'UNSUPPORTED_CREDENTIAL', checked: checksOf('not_checked') }
  }
  if (options.expectedIssuerId !== undefined && secured.issuer !== options.expectedIssuerId) {
    return { valid: false, reason: 'ISSUER_MISMATCH', checked: checksOf('not_checked') }
  }

  // §5.9 Verification Method Binding: sem resolução remota de chave, o binding é
  // estrutural — o método de verificação precisa pertencer ao issuer declarado
  // (`<issuer>#<keyId>`, com fragmento não vazio). Sem esta checagem, um
  // documento assinado por A poderia se declarar emitido por B e passaria.
  const verificationMethod = secured.proof.verificationMethod
  const issuerFragment = `${secured.issuer}#`
  if (!verificationMethod.startsWith(issuerFragment) || verificationMethod.length === issuerFragment.length) {
    return {
      valid: false,
      reason: 'VERIFICATION_METHOD_MISMATCH',
      checked: checksOf('not_checked'),
    }
  }
  // Vínculo com a chave confiável: a assinatura tem de ser do método que o
  // consumidor declarou confiar. Só a chave pública não basta — ela é
  // reaproveitável entre métodos (`#key-1`, `#key-2`) do mesmo issuer.
  if (verificationMethod !== options.trusted.id) {
    return {
      valid: false,
      reason: 'VERIFICATION_METHOD_MISMATCH',
      checked: checksOf('not_checked'),
    }
  }

  const validFrom = timestampOf(secured.validFrom)
  const validUntil = secured.validUntil === undefined ? null : timestampOf(secured.validUntil)
  if (validFrom === null || (secured.validUntil !== undefined && validUntil === null)) {
    return { valid: false, reason: 'INVALID_TIMESTAMP', checked: checksOf('not_checked') }
  }
  // Janela NÃO vazia: `validFrom < validUntil`, a mesma garantia que a emissão
  // impõe (`buildAssertion`). A igualdade será tratada na revisão da VC 2.0
  // §4.9 (item A4).
  if (validUntil !== null && validFrom >= validUntil) {
    return { valid: false, reason: 'INVALID_TIMESTAMP', checked: checksOf('not_checked') }
  }

  if (
    evidenceSetHashOfCredential(secured.evidence.map(observationOfEvidence)) !==
    secured['comprova:evidenceSetHash']
  ) {
    return {
      valid: false,
      reason: 'EVIDENCE_SET_MISMATCH',
      checked: checksOf('not_checked'),
    }
  }

  const proof = verifyDataIntegrityProof(raw, {
    publicKey: options.trusted.publicKey,
    expectedProofPurpose: ASSERTION_METHOD,
  })
  if (!proof.valid) {
    return {
      valid: false,
      reason: proofFailure(proof.reason),
      checked: checksOf('invalid'),
    }
  }

  // A prova é verificada ANTES do binding: adulterar `id`/`credentialStatus.id`
  // depois da assinatura falha como INVALID_SIGNATURE (o material está coberto
  // pela prova). Um documento assinado assim, mas estruturalmente incoerente,
  // falha como MALFORMED_CREDENTIAL — nunca é aceito.
  if (!isCredentialStatusBindingValid(secured)) {
    return { valid: false, reason: 'MALFORMED_CREDENTIAL', checked: checksOf('invalid') }
  }

  // Tempo: só é checado quando o consumidor injeta `now`. A ordem (depois da
  // assinatura) garante que um documento adulterado nunca é classificado como
  // "expirado" em vez de "assinatura inválida".
  if (options.now !== undefined) {
    const now = options.now.getTime()
    if (!Number.isFinite(now)) {
      return { valid: false, reason: 'INVALID_TIMESTAMP', checked: checksOf('valid') }
    }
    if (now < validFrom) {
      return {
        valid: false,
        reason: 'NOT_YET_VALID',
        checked: checksOf('valid', 'not_yet_valid'),
      }
    }
    // `validUntil` é o instante em que a credencial DEIXA de ser válida:
    // `[validFrom, validUntil)`.
    if (validUntil !== null && now >= validUntil) {
      return { valid: false, reason: 'EXPIRED', checked: checksOf('valid', 'expired') }
    }
    return { valid: true, checked: checksOf('valid', 'valid') }
  }

  return { valid: true, checked: checksOf('valid') }
}

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
 * Falha de verificação com resolução: as mesmas razões de
 * `verifyCredentialIntegrity` mais `VERIFICATION_METHOD_UNRESOLVED` (o método
 * não pôde ser resolvido),
 * `STATUS_REVOKED` (o status público é REVOKED) e `STATUS_UNAVAILABLE`
 * (status ausente, desconhecido, HTTP/rede com erro ou resolver não fornecido).
 */
export type IssuerVerificationFailure =
  CredentialVerificationFailure | 'VERIFICATION_METHOD_UNRESOLVED' | 'STATUS_REVOKED' | 'STATUS_UNAVAILABLE'

export type IssuerVerificationResult =
  { readonly valid: true } | { readonly valid: false; readonly reason: IssuerVerificationFailure }

export interface VerifyFromIssuerOptions {
  /** Issuer esperado pelo consumidor. Quando informado, precisa ser o `issuer` da credencial. */
  readonly expectedIssuerId?: string
  /**
   * Instante para a checagem temporal. Repassado a
   * `verifyCredentialIntegrity`; quando omitido, o tempo não é checado.
   */
  readonly now?: Date
  /**
   * Resolvedor do status público. A verificação é FAIL CLOSED: sem este
   * resolver — ou se ele lançar/retornar algo que não seja ACTIVE/REVOKED —,
   * uma credencial com `credentialStatus` é recusada como
   * `STATUS_UNAVAILABLE`. O status é resolvido só DEPOIS da assinatura e do
   * binding estrutural, então uma credencial adulterada nunca faz uma busca.
   */
  readonly statusResolver?: CredentialStatusResolver
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

/** URL de status declarada no documento já validado (ou `null` se ausente). */
const credentialStatusUrlOfCredential = (credential: unknown): string | null => {
  const parsed = SecuredVerifiableCredentialSchema.safeParse(credential)
  return parsed.success ? (parsed.data.credentialStatus?.id ?? null) : null
}

/**
 * Verificação independente com resolução de chave e de status: valida a forma
 * mínima da credencial, amarra o `verificationMethod` ao `issuer` declarado,
 * resolve o material público pelo resolver injetado, delega a verificação
 * criptográfica a `verifyCredentialIntegrity` e, por fim, resolve o status
 * público.
 *
 * Segurança do resolver (§7): a chave resolvida só vale para o método EXATO que
 * a credencial declara (`resolved.id === verificationMethod`) e esse método tem
 * de pertencer ao issuer declarado (`<issuer>#<fragmento>`). A resolução é
 * injetada — e `makeHttpIssuerResolver` acrescenta a allowlist de origens —,
 * então uma credencial não consegue escolher uma chave arbitrária controlada por
 * um atacante.
 *
 * Status (ADR-0027): a resolução acontece só DEPOIS de a assinatura e o binding
 * `credentialStatus.id == <id>/status` serem validados. `ACTIVE` → válida;
 * `REVOKED` → `STATUS_REVOKED`; status ausente, resolver ausente, erro HTTP/rede
 * ou valor desconhecido → `STATUS_UNAVAILABLE` (fail closed). O valor do status
 * nunca é inferido como ACTIVE.
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

  const verified = verifyCredentialIntegrity(credential, {
    trusted: { id: resolved.id, publicKey: resolved.publicKey },
    expectedIssuerId: issuer,
    ...(options.now !== undefined ? { now: options.now } : {}),
  })
  if (!verified.valid) return { valid: false, reason: verified.reason }

  // Fail closed: a credencial emitida pela API sempre carrega `credentialStatus`,
  // e o consumidor precisa fornecer um resolver. Ausência/erro nunca vira ACTIVE.
  const statusUrl = credentialStatusUrlOfCredential(credential)
  if (statusUrl === null || options.statusResolver === undefined) {
    return { valid: false, reason: 'STATUS_UNAVAILABLE' }
  }

  let status: string
  try {
    status = await options.statusResolver(statusUrl)
  } catch {
    return { valid: false, reason: 'STATUS_UNAVAILABLE' }
  }
  if (status === 'REVOKED') return { valid: false, reason: 'STATUS_REVOKED' }
  if (status === 'ACTIVE') return { valid: true }
  return { valid: false, reason: 'STATUS_UNAVAILABLE' }
}

export interface HttpIssuerResolverOptions {
  /**
   * Origens de issuer em que o consumidor confia. Só métodos sob estas origens
   * são buscados: é o que impede a credencial de apontar para uma URL arbitrária.
   */
  readonly trustedIssuerOrigins: readonly string[]
  /**
   * Quando `true`, descobre o documento pelo endpoint bem-conhecido
   * `/.well-known/comprova-issuer/<escopo>` em vez de buscar diretamente a URL
   * do issuer. O documento devolvido continua tendo de declarar `id` igual à
   * URL do issuer; a allowlist e a ausência de redirect/query valem para a
   * mesma origem. Default: `false` (comportamento anterior, compatível).
   */
  readonly discover?: boolean
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

const issuerDocumentUrlOf = (issuerUrl: string, discover: boolean): string => {
  if (!discover) return issuerUrl
  try {
    return wellKnownIssuerUrlOf(issuerUrl)
  } catch (error) {
    throw new VerificationMethodResolutionError(
      `issuer URL has no well-known discovery mapping: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

/**
 * Resolver HTTP concreto (FASE 13): busca o documento de chave do issuer e
 * devolve a chave do método pedido.
 *
 * Por padrão busca `GET <issuer.id>`; com `discover: true`, busca o MESMO
 * documento em `GET <origem>/.well-known/comprova-issuer/<escopo>` (descoberta
 * padronizada, sem DID).
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
    // `issuerUrl` é a identidade que o documento precisa declarar; a URL de
    // fetch pode ser a porta de descoberta, mas nunca muda o issuer esperado.
    const issuerUrl = `${url.origin}${url.pathname}`
    const documentUrl = issuerDocumentUrlOf(issuerUrl, options.discover === true)

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
    // O tipo é usado apenas para documentar a forma validada pelo schema.
    const document = parsed.data
    if (document.id !== issuerUrl) {
      throw new VerificationMethodResolutionError(
        'issuer key document id does not match the requested issuer',
      )
    }
    const method = document.verificationMethod.find((entry) => entry.id === verificationMethod)
    if (method === undefined) {
      throw new VerificationMethodResolutionError(`verification method not found: ${verificationMethod}`)
    }
    if (method.controller !== document.id) {
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
