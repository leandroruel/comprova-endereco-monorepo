import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isSafeExternalUrl } from '@comprova/providers'

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

/**
 * Validação antecipada de UX no cadastro. Não resolve DNS e não substitui a
 * guarda `safeExternalFetch`, que valida IP e conexão no envio (ADR-0036).
 */
export const isSafeWebhookUrl = (url: string): boolean => isSafeExternalUrl(url)
