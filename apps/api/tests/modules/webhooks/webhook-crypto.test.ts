import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret } from '../../../src/shared/secretbox.js'
import {
  isSafeWebhookUrl,
  newWebhookSecret,
  signWebhookPayload,
  verifyWebhookSignature,
} from '../../../src/modules/webhooks/webhook-crypto.js'

describe('webhook crypto', () => {
  it('segredo e cifrado e restaurado com AES-256-GCM', () => {
    const pepper = 'test-pepper-123'
    const secret = newWebhookSecret()
    const sealed = encryptSecret(pepper, secret)
    expect(decryptSecret(pepper, sealed)).toBe(secret)
  })

  it('assinatura HMAC e verificavel e expira na janela anti-replay', () => {
    const secret = newWebhookSecret()
    const payload = JSON.stringify({ a: 1 })
    const { timestamp, signature } = signWebhookPayload(secret, payload)
    expect(verifyWebhookSignature(secret, payload, timestamp, signature)).toBe(true)
    expect(verifyWebhookSignature('outra-chave', payload, timestamp, signature)).toBe(false)
    const old = Date.now() - 600_000
    const oldSig = signWebhookPayload(secret, payload, old)
    expect(verifyWebhookSignature(secret, payload, old, oldSig.signature)).toBe(false)
  })

  it('URLs privadas/locais sao bloqueadas (SSRF)', () => {
    expect(isSafeWebhookUrl('https://example.com/hook')).toBe(true)
    expect(isSafeWebhookUrl('http://localhost:3000/hook')).toBe(false)
    expect(isSafeWebhookUrl('https://localhost/hook')).toBe(false)
    expect(isSafeWebhookUrl('http://169.254.169.254/latest')).toBe(false)
    expect(isSafeWebhookUrl('https://169.254.169.254/latest')).toBe(false)
    expect(isSafeWebhookUrl('http://10.0.0.5/hook')).toBe(false)
    expect(isSafeWebhookUrl('https://10.0.0.5/hook')).toBe(false)
    expect(isSafeWebhookUrl('https://172.16.0.5/hook')).toBe(false)
    expect(isSafeWebhookUrl('https://192.168.0.5/hook')).toBe(false)
    expect(isSafeWebhookUrl('https://[::1]/hook')).toBe(false)
    expect(isSafeWebhookUrl('https://[fe80::1]/hook')).toBe(false)
    expect(isSafeWebhookUrl('https://[fc00::1]/hook')).toBe(false)
    expect(isSafeWebhookUrl('https://user:pass@example.com/hook')).toBe(false)
    expect(isSafeWebhookUrl('ftp://example.com')).toBe(false)
    expect(isSafeWebhookUrl('not-a-url')).toBe(false)
  })
})
