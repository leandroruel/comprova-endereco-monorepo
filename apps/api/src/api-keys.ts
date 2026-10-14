import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

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

export const keyPrefixOf = (plaintext: string): string => plaintext.slice(0, 12)
