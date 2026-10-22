import { randomUUID } from 'node:crypto'
import { createDbPool, eq, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import { createLogger } from '@comprova/observability'
import { SafeFetchError } from '@comprova/providers'
import type { SafeFetch } from '@comprova/providers'
import { createTenant, startTestDb, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import { afterAll, describe, expect, it } from 'vitest'
import { publishTick } from '../../../src/modules/webhooks/outbox-publisher.js'
import { verifyWebhookSignature } from '../../../src/modules/webhooks/webhook-crypto.js'
import { encryptSecret } from '../../../src/shared/secretbox.js'

const PEPPER = 'test-pepper-webhook-safe-fetch'
const SENSITIVE_PAYLOAD_MARKER = 'do-not-log-this-payload'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const tenant = await createTenant(adminPool.db, { name: 'webhook-safe-fetch' })

afterAll(async () => {
  await adminPool.end()
  await db.stop()
})

const createPendingDelivery = async (
  url: string,
): Promise<{ deliveryId: string; endpointId: string; secret: string }> => {
  const endpointId = randomUUID()
  const deliveryId = randomUUID()
  const secret = `whsec_${randomUUID()}`
  await adminPool.db.insert(t.webhookEndpoint).values({
    endpointId,
    tenantId: tenant,
    url,
    secretEnc: encryptSecret(PEPPER, secret),
    events: ['validation.completed'],
    active: true,
  })
  await adminPool.db.insert(t.webhookDelivery).values({
    deliveryId,
    endpointId,
    validationId: randomUUID(),
    attempt: 0,
    nextAttemptAt: new Date(0),
    status: 'pending',
    payload: {
      tenant_id: tenant,
      marker: SENSITIVE_PAYLOAD_MARKER,
      document: { type: 'CNPJ', value: '12345678000195' },
    },
    eventType: 'validation.completed',
  })
  return { deliveryId, endpointId, secret }
}

const getDelivery = async (deliveryId: string) => {
  const [delivery] = await adminPool.db
    .select()
    .from(t.webhookDelivery)
    .where(eq(t.webhookDelivery.deliveryId, deliveryId))
  return delivery
}

const memoryLogger = (lines: string[]) =>
  createLogger({
    level: 'warn',
    stream: { write: (line) => lines.push(line) },
  })

describe('webhook com safe fetch', () => {
  it('entrega webhook HTTPS válido usando POST assinado', async () => {
    const { deliveryId, secret } = await createPendingDelivery('https://example.com/hook')
    let captured:
      | {
          body: string
          headers: Readonly<Record<string, string>>
          method: string | undefined
        }
      | undefined

    const fakeSafeFetch: SafeFetch = async (_url, options) => {
      captured = {
        body: typeof options?.body === 'string' ? options.body : '',
        headers: options?.headers ?? {},
        method: options?.method,
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{"ok":true}'),
        address: '8.8.8.8',
      }
    }

    await publishTick({
      db: adminPool.db,
      pepper: PEPPER,
      logger: createLogger({ level: 'silent' }),
      safeFetch: fakeSafeFetch,
    })

    const delivery = await getDelivery(deliveryId)
    expect(delivery?.status).toBe('delivered')
    expect(delivery?.attempt).toBe(1)
    expect(captured?.method).toBe('POST')
    expect(captured?.headers['Content-Type']).toBe('application/json')
    expect(captured?.headers['X-Signature']).toBeDefined()
    expect(captured?.headers['X-Timestamp']).toBeDefined()
    expect(
      verifyWebhookSignature(
        secret,
        captured?.body ?? '',
        Number(captured?.headers['X-Timestamp']),
        captured?.headers['X-Signature'] ?? '',
      ),
    ).toBe(true)
  })

  it('usa a guarda real por padrão e rejeita host loopback no envio', async () => {
    const lines: string[] = []
    const { deliveryId } = await createPendingDelivery('https://127.0.0.1/hook')

    await publishTick({
      db: adminPool.db,
      pepper: PEPPER,
      logger: memoryLogger(lines),
    })

    const delivery = await getDelivery(deliveryId)
    expect(delivery?.status).toBe('pending')
    expect(delivery?.attempt).toBe(1)
    expect(delivery?.lastError).toBe('LOOPBACK_IP')

    const log = lines.join('\n')
    expect(log).toContain('LOOPBACK_IP')
    expect(log).toContain('"hostname":"127.0.0.1"')
  })

  it.each([
    ['PRIVATE_IP', 'https://public.example/hook'],
    ['REDIRECT_BLOCKED', 'https://redirect.example/hook'],
    ['RESPONSE_TOO_LARGE', 'https://large.example/hook'],
    ['CONTENT_TYPE_NOT_ALLOWED', 'https://content-type.example/hook'],
    ['TIMEOUT', 'https://slow.example/hook'],
  ] as const)('trata %s como falha de entrega', async (reason, url) => {
    const lines: string[] = []
    const { deliveryId } = await createPendingDelivery(url)
    const failingSafeFetch: SafeFetch = async () => {
      throw new SafeFetchError(reason, 'bloqueado', { hostname: new URL(url).hostname })
    }

    await publishTick({
      db: adminPool.db,
      pepper: PEPPER,
      logger: memoryLogger(lines),
      safeFetch: failingSafeFetch,
    })

    const delivery = await getDelivery(deliveryId)
    expect(delivery?.status).toBe('pending')
    expect(delivery?.attempt).toBe(1)
    expect(delivery?.lastError).toBe(reason)
    expect(lines.join('\n')).toContain(reason)
  })

  it('não registra payload, segredo, assinatura nem Authorization no log', async () => {
    const lines: string[] = []
    const { deliveryId } = await createPendingDelivery('https://private.example/hook')
    let signature = ''

    const failingSafeFetch: SafeFetch = async (_url, options) => {
      signature = options?.headers?.['X-Signature'] ?? ''
      throw new SafeFetchError('PRIVATE_IP', 'bloqueado', { hostname: 'private.example' })
    }

    await publishTick({
      db: adminPool.db,
      pepper: PEPPER,
      logger: memoryLogger(lines),
      safeFetch: failingSafeFetch,
    })

    const log = lines.join('\n')
    expect(log).toContain('PRIVATE_IP')
    expect(log).toContain('private.example')
    expect(log).not.toContain(SENSITIVE_PAYLOAD_MARKER)
    expect(log).not.toContain('12345678000195')
    expect(log).not.toContain('authorization')
    expect(log).not.toContain('X-Signature')
    expect(log).not.toContain(signature)
    expect(log).not.toContain('whsec_')

    const delivery = await getDelivery(deliveryId)
    expect(delivery?.lastError).toBe('PRIVATE_IP')
  })
})
