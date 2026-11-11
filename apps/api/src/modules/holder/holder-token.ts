import { createHmac, randomBytes } from 'node:crypto'

/**
 * Token opaco de acesso do Holder (F4.2).
 *
 * Formato: `hlt_` + 32 bytes aleatórios em base64url (43 caracteres). O
 * prefixo indexado são os 12 primeiros caracteres. O valor persistido é o
 * HMAC-SHA-256 com pepper e separação de domínio; o token em texto puro só
 * existe na resposta de emissão.
 */
export const HOLDER_TOKEN_DOMAIN = 'holder-token:'
export const HOLDER_TOKEN_PREFIX_LENGTH = 12
const HOLDER_TOKEN_PATTERN = /^hlt_[A-Za-z0-9_-]{43}$/

export const newHolderAccessToken = (): string => `hlt_${randomBytes(32).toString('base64url')}`

export const holderTokenPrefixOf = (token: string): string => token.slice(0, HOLDER_TOKEN_PREFIX_LENGTH)

export const isHolderTokenFormat = (token: string | undefined): token is string =>
  token !== undefined && HOLDER_TOKEN_PATTERN.test(token)

export const hashHolderAccessToken = (token: string, pepper: string): Buffer =>
  createHmac('sha256', pepper).update(`${HOLDER_TOKEN_DOMAIN}${token}`).digest()
