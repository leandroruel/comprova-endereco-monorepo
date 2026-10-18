import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * Identidade do issuer (VC Data Model 2.0 §4.6 + Data Integrity 1.0 §2.1.1).
 *
 * `id` é uma URL HTTPS e `keyId` é o fragmento que aponta a chave dentro dela.
 * Trocar a chave (rotação) muda o fragmento (`verificationMethod`), não a
 * identidade do issuer: a mesma origem + tenant continua produzindo o mesmo
 * `id`. A resolução do documento de chave NÃO existe nesta camada (ver
 * ADR-0024 §2): a chave pública é injetada no verifier (ADR-0019 §3).
 */
export interface IssuerIdentity {
  readonly id: string
  readonly keyId: string
}

export class IssuerIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IssuerIdentityError'
  }
}

/** Segmento de namespace dos issuers dentro da origem do projeto. */
export const ISSUERS_PATH = 'issuers'
/** Segmento de namespace dos subjects dentro do issuer (ver `subject.ts`). */
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
const assertKeyId = (keyId: string): string => {
  if (keyId.trim() === '' || /[\s#?]/.test(keyId)) {
    throw new IssuerIdentityError(`issuer keyId is not a URL fragment: ${JSON.stringify(keyId)}`)
  }
  return keyId
}

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
