import { createHash, createPublicKey, type KeyObject } from 'node:crypto'
import { z } from 'zod'
import {
  MULTIKEY_TYPE,
  type IssuerIdentity,
  type IssuerKeyDocument,
  type IssuerVerificationKey,
} from '../schema/issuer.schema.js'
import { decodeMultibaseBase58Btc, encodeMultibaseBase58Btc } from './encoding.service.js'

/**
 * Identidade e chaves do issuer (VC Data Model 2.0 §4.6 + Data Integrity 1.0
 * §2.1.1). Este service é puro: não acessa banco, rede ou ambiente.
 *
 * `id` é uma URL HTTPS e `keyId` é o fragmento que aponta a chave dentro dela.
 * Trocar a chave (rotação) muda o fragmento (`verificationMethod`), não a
 * identidade do issuer: a mesma origem + tenant continua produzindo o mesmo
 * `id`. A resolução do documento de chave NÃO existe nesta camada (ver
 * ADR-0024 §2): a chave pública é injetada no verifier (ADR-0019 §3).
 */

export class IssuerIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IssuerIdentityError'
  }
}

/** Segmento de namespace dos issuers dentro da origem do projeto. */
export const ISSUERS_PATH = 'issuers'
/** Segmento de namespace dos subjects dentro do issuer (ver `subject.service.ts`). */
export const SUBJECTS_PATH = 'subjects'

/** Domínio de separação do escopo do issuer (evita colisão com outros hashes). */
const ISSUER_SCOPE_DOMAIN = 'comprova:issuer:v1'

/**
 * Valida e normaliza a origem HTTPS do projeto e devolve a forma canônica
 * (`https://host[:port]`), sem credenciais, path, query ou fragmento.
 *
 * Não existe default: o projeto **não** declara controle de um domínio
 * inventado. A origem é configuração explícita e validada
 * (`CREDENTIAL_ISSUER_ORIGIN` na API); o valor canônico devolvido aqui é o que
 * entra em `issuer.id` e em `verificationMethod`.
 *
 * `https:` é obrigatório — o identificador do issuer é uma URL pública e a
 * verificação (Data Integrity) pressupõe transporte seguro. `.test` e afins
 * são aceitos em teste justamente porque contrato é "a origem que o projeto
 * controla", não "um domínio que a biblioteca conhece".
 */
export const parseIssuerOrigin = (value: string): string => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new IssuerIdentityError(`issuer origin is not a URL: ${value}`)
  }
  if (url.protocol !== 'https:') {
    throw new IssuerIdentityError(`issuer origin must be https (got ${url.protocol}): ${value}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new IssuerIdentityError(`issuer origin must not carry credentials: ${value}`)
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new IssuerIdentityError(`issuer origin must be a bare origin (no path/query/fragment): ${value}`)
  }
  return url.origin
}

/**
 * Mesma validação de `parseIssuerOrigin`, para a configuração da aplicação (a
 * mensagem de erro do parser é preservada no relatório do zod).
 */
export const IssuerOriginSchema = z.string().transform((value, ctx) => {
  try {
    return parseIssuerOrigin(value)
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) })
    return z.NEVER
  }
})

/**
 * Escopo opaco do tenant: `base64url(sha256(domínio | tenant_id))`.
 *
 * O `tenant_id` é um identificador interno; a URL do issuer é pública e não
 * precisa expô-lo. O digest é determinístico (mesma entrada → mesmo escopo) e
 * unidirecional, então dois tenants nunca compartilham escopo sem que o UUID
 * interno apareça na credencial.
 */
export const issuerScopeOf = (tenantId: string): string =>
  createHash('sha256').update(`${ISSUER_SCOPE_DOMAIN}|${tenantId}`, 'utf8').digest('base64url')

/**
 * `issuer.id` estável de um tenant: `<origem>/issuers/<escopo>`.
 *
 * A forma é deliberadamente plana (uma URL de "documento do issuer" com o
 * escopo no path) para que uma futura publicação de chaves possa servir esse
 * mesmo URL. O fragmento do `verificationMethod` é o que aponta a chave.
 */
export const issuerIdOf = (origin: string, tenantId: string): string =>
  `${parseIssuerOrigin(origin)}/${ISSUERS_PATH}/${issuerScopeOf(tenantId)}`

/**
 * O `keyId` vira fragmento de URL (`#<keyId>`): precisa existir e ser
 * utilizável como fragmento (sem espaço, `#` ou `?`), senão o
 * `verificationMethod` não é uma URL válida.
 */
export const assertKeyId = (keyId: string): string => {
  if (keyId.trim() === '' || /[\s#?]/.test(keyId)) {
    throw new IssuerIdentityError(`issuer keyId is not a URL fragment: ${JSON.stringify(keyId)}`)
  }
  return keyId
}

/**
 * Mesma validação de `assertKeyId`, para a configuração da aplicação (a mensagem
 * de erro do assert é preservada no relatório do zod). Rejeitar aqui evita que
 * um `key_id` inválido só falhe na hora de montar o `verificationMethod`.
 */
export const KeyIdSchema = z.string().transform((value, ctx) => {
  try {
    return assertKeyId(value)
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) })
    return z.NEVER
  }
})

export const localIssuer = (origin: string, tenantId: string, keyId: string): IssuerIdentity => ({
  id: issuerIdOf(origin, tenantId),
  keyId: assertKeyId(keyId),
})

/**
 * Referência de chave publicada no `proof.verificationMethod` (Data Integrity):
 * a URL do issuer com a chave como fragmento.
 */
export const verificationMethodOf = (issuer: IssuerIdentity): string =>
  `${issuer.id}#${assertKeyId(issuer.keyId)}`

/**
 * Chave pública Ed25519 no formato `publicKeyMultibase` da W3C (Multikey):
 * `multibase(base58btc)( multicodec("ed25519-pub") || chave crua de 32 bytes )`.
 *
 * O prefixo multicodec `0xed 0x01` (varint) diz ao consumidor que os bytes
 * seguintes são uma chave Ed25519; sem ele, os 32 bytes crus não são
 * auto-descritivos. É o formato que a Data Integrity espera em
 * `publicKeyMultibase` e o que o ADR-0024 §2 antecipa para a publicação da
 * chave — nada proprietário, nenhuma dependência nova.
 */
export class PublicKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublicKeyError'
  }
}

/** multibase + multicodec `ed25519-pub`. */
const ED25519_MULTICODEC = Buffer.from([0xed, 0x01])
/** Preâmbulo SPKI DER de uma chave Ed25519 (RFC 8410), sem os 32 bytes da chave. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const ED25519_PUBLIC_KEY_BYTES = 32

/** Bytes crus da chave Ed25519 (32) a partir do `KeyObject`. */
const rawEd25519Of = (publicKey: KeyObject): Buffer => {
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new PublicKeyError(`public key must be Ed25519 (got ${publicKey.asymmetricKeyType ?? 'unknown'})`)
  }
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const prefix = spki.subarray(0, ED25519_SPKI_PREFIX.length)
  const raw = spki.subarray(ED25519_SPKI_PREFIX.length)
  if (!prefix.equals(ED25519_SPKI_PREFIX) || raw.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new PublicKeyError('unexpected Ed25519 SPKI encoding')
  }
  return raw
}

/**
 * Bytes crus da chave pública Ed25519 (32). É o formato sem autodescrição que o
 * banco guarda na coluna `public_key`; a descrição de tipo (`ed25519-pub`) entra
 * só na serialização pública (`publicKeyMultibase`).
 */
export const ed25519PublicKeyBytes = (publicKey: KeyObject): Buffer => rawEd25519Of(publicKey)

/** Reconstrói o `KeyObject` a partir dos 32 bytes crus (inverso do acima). */
export const ed25519PublicKeyFromBytes = (bytes: Uint8Array): KeyObject => {
  const raw = Buffer.from(bytes)
  if (raw.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new PublicKeyError(`Ed25519 public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes`)
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  })
}

export const encodeEd25519PublicKeyMultibase = (publicKey: KeyObject): string =>
  encodeMultibaseBase58Btc(Buffer.concat([ED25519_MULTICODEC, rawEd25519Of(publicKey)]))

export const decodeEd25519PublicKeyMultibase = (value: string): KeyObject => {
  const bytes = Buffer.from(decodeMultibaseBase58Btc(value))
  const prefix = bytes.subarray(0, ED25519_MULTICODEC.length)
  if (!prefix.equals(ED25519_MULTICODEC)) {
    throw new PublicKeyError('multibase value does not start with the ed25519-pub multicodec prefix')
  }
  return ed25519PublicKeyFromBytes(bytes.subarray(ED25519_MULTICODEC.length))
}

/**
 * Materializa o documento do issuer a partir do `issuer.id` e das chaves
 * públicas publicadas naquele issuer. Puro: não lê banco nem ambiente.
 *
 * Lista TODAS as chaves fornecidas — o que permite coexistência de rotação
 * (a credencial antiga aponta `#key-1`, a nova `#key-2`, ambas resolvíveis no
 * mesmo documento). Enquanto não há rotação, a lista tem um único método.
 */
export const issuerKeyDocumentOf = (
  issuerId: string,
  methods: readonly IssuerVerificationKey[],
): IssuerKeyDocument => ({
  id: issuerId,
  verificationMethod: methods.map(({ keyId, publicKey }) => {
    const identity: IssuerIdentity = { id: issuerId, keyId }
    return {
      id: verificationMethodOf(identity),
      type: MULTIKEY_TYPE,
      controller: issuerId,
      publicKeyMultibase: encodeEd25519PublicKeyMultibase(publicKey),
    }
  }),
})
