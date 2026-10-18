import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Chave de API: formato, prefixo indexado e hash.
 *
 * Vive no pacote (e não no app da API) porque a mesma regra é usada por três
 * lugares: a API verifica (`makeApiKeyHasher`), o seed cria (`newApiKey` +
 * `keyPrefixOf`) e o ingestor cria tenants de carga. Verificação e criação em
 * arquivos separados foi como o `bootstrap` acabou gravando argon2 enquanto a
 * API comparava HMAC — chave que nunca autenticava.
 */
export interface ApiKeyHasher {
  readonly hash: (plaintext: string) => Buffer
  readonly verify: (stored: Buffer, plaintext: string) => boolean
}

export const makeApiKeyHasher = (pepper: string): ApiKeyHasher => ({
  hash: (plaintext: string): Buffer => createHmac('sha256', pepper).update(plaintext).digest(),
  verify: (stored: Buffer, plaintext: string): boolean => {
    const computed = createHmac('sha256', pepper).update(plaintext).digest()
    return stored.length === computed.length && timingSafeEqual(stored, computed)
  },
})

export const newApiKey = (): string => `cvk_${randomBytes(24).toString('base64url')}`

/** Prefixo indexado (12 chars): a busca da linha é por ele, sem varrer a tabela. */
export const keyPrefixOf = (plaintext: string): string => plaintext.slice(0, 12)
