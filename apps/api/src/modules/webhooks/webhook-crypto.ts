import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

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
  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest()
  const received = Buffer.from(signature, 'hex')
  return received.length === expected.length && timingSafeEqual(expected, received)
}

const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|\[?::1)/i

export const isSafeWebhookUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    return !PRIVATE_HOST_RE.test(parsed.hostname)
  } catch {
    return false
  }
}
