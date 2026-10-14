import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'

const deriveKey = (pepper: string): Buffer => createHash('sha256').update(`webhook-secret:${pepper}`).digest()

export const encryptSecret = (pepper: string, plaintext: string): Buffer => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(pepper), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted])
}

export const decryptSecret = (pepper: string, sealed: Buffer): string => {
  const iv = sealed.subarray(0, 12)
  const tag = sealed.subarray(12, 28)
  const encrypted = sealed.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(pepper), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

export const newWebhookSecret = (): string => `whsec_${randomBytes(24).toString('base64url')}`

export interface WebhookSignature {
  readonly timestamp: number
  readonly signature: string
}

export const signWebhookPayload = (
  secret: string,
  payload: string,
  timestampMs = Date.now(),
): WebhookSignature => ({
  timestamp: timestampMs,
  signature: createHmac('sha256', secret).update(`${timestampMs}.${payload}`).digest('hex'),
})

export const verifyWebhookSignature = (
  secret: string,
  payload: string,
  timestamp: number,
  signature: string,
  toleranceSeconds = 300,
): boolean => {
  if (Math.abs(Date.now() - timestamp) > toleranceSeconds * 1000) return false
  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')
  return expected.length === signature.length && expected === signature
}

const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|\[?::1)/i

export const isSafeWebhookUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    return !PRIVATE_HOST_RE.test(parsed.hostname)
  } catch {
    return false
  }
}
