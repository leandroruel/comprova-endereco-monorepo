import { and, eq, isNull, lte, sql } from '@comprova/db'
import type { Db } from '@comprova/db'
import { withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { randomUUID } from 'node:crypto'
import type { Logger } from '@comprova/observability'
import { decryptSecret, signWebhookPayload } from '../webhooks.js'

export interface PublisherDeps {
  readonly db: Db
  readonly pepper: string
  readonly logger: Logger
  readonly fetchImpl?: typeof fetch
  readonly now?: () => Date
  readonly maxAttempts?: number
}

interface OutboxEventRow {
  readonly outboxId: number
  readonly aggregate: string
  readonly aggregateId: string
  readonly eventType: string
  readonly payload: Record<string, unknown>
}

const TENANT_ID_ERROR = 'outbox event without tenant_id in payload'

const createDeliveriesForNewEvents = async (deps: PublisherDeps): Promise<number> => {
  const now = (deps.now ?? (() => new Date()))()
  const events = (await deps.db
    .select({
      outboxId: t.outbox.outboxId,
      aggregate: t.outbox.aggregate,
      aggregateId: t.outbox.aggregateId,
      eventType: t.outbox.eventType,
      payload: t.outbox.payload,
    })
    .from(t.outbox)
    .where(isNull(t.outbox.publishedAt))
    .orderBy(t.outbox.outboxId)
    .limit(20)) as readonly OutboxEventRow[]

  const created = await events.reduce<Promise<number>>(
    async (acc, event) =>
      event.payload['tenant_id'] === undefined || typeof event.payload['tenant_id'] !== 'string'
        ? Promise.reject(new Error(TENANT_ID_ERROR))
        : (await acc) +
          (await withTenant(deps.db, event.payload['tenant_id'] as string, async (tx) => {
            const endpoints = await tx
              .select({
                endpointId: t.webhookEndpoint.endpointId,
              })
              .from(t.webhookEndpoint)
              .where(
                and(
                  eq(t.webhookEndpoint.active, true),
                  sql`${t.webhookEndpoint.events} @> ARRAY[${event.eventType}]::text[]`,
                ),
              )
            if (endpoints.length === 0) return 0
            await tx.insert(t.webhookDelivery).values(
              endpoints.map((endpoint) => ({
                deliveryId: randomUUID(),
                endpointId: endpoint.endpointId,
                validationId: event.aggregateId,
                status: 'pending',
                attempt: 0,
                nextAttemptAt: now,
                payload: event.payload,
                eventType: event.eventType,
              })),
            )
            return endpoints.length
          })),
    Promise.resolve(0),
  )

  if (events.length > 0) {
    await deps.db
      .update(t.outbox)
      .set({ publishedAt: now })
      .where(
        sql`${t.outbox.outboxId} IN (${sql.join(
          events.map((e) => sql`${e.outboxId}`),
          sql`, `,
        )})`,
      )
  }
  return created
}

const processDueDeliveries = async (deps: PublisherDeps): Promise<number> => {
  const now = (deps.now ?? (() => new Date()))()
  const doFetch = deps.fetchImpl ?? fetch
  const maxAttempts = deps.maxAttempts ?? 5

  const due = (await deps.db
    .select({
      deliveryId: t.webhookDelivery.deliveryId,
      endpointId: t.webhookDelivery.endpointId,
      validationId: t.webhookDelivery.validationId,
      attempt: t.webhookDelivery.attempt,
      payload: t.webhookDelivery.payload,
      eventType: t.webhookDelivery.eventType,
      url: t.webhookEndpoint.url,
      secretEnc: t.webhookEndpoint.secretEnc,
      tenantId: t.webhookEndpoint.tenantId,
    })
    .from(t.webhookDelivery)
    .innerJoin(t.webhookEndpoint, eq(t.webhookDelivery.endpointId, t.webhookEndpoint.endpointId))
    .where(and(eq(t.webhookDelivery.status, 'pending'), lte(t.webhookDelivery.nextAttemptAt, now)))
    .limit(10)) as readonly {
    deliveryId: string
    endpointId: string
    validationId: string
    attempt: number
    payload: Record<string, unknown>
    eventType: string
    url: string
    secretEnc: Buffer
    tenantId: string
  }[]

  await due.reduce<Promise<number>>(async (acc, delivery) => {
    const delivered = await acc
    const body = JSON.stringify({
      type: delivery.eventType,
      delivery_id: delivery.deliveryId,
      payload: delivery.payload,
    })
    const { timestamp, signature } = signWebhookPayload(
      decryptSecret(deps.pepper, Buffer.from(delivery.secretEnc)),
      body,
      now.getTime(),
    )
    let status: 'delivered' | 'failed' = 'failed'
    let lastError: string | null = null
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8_000)
      const res = await doFetch(delivery.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
          'X-Timestamp': String(timestamp),
        },
        body,
        signal: controller.signal,
      })
      clearTimeout(timer)
      status = res.status >= 200 && res.status < 300 ? 'delivered' : 'failed'
      if (status === 'failed') lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }

    const nextAttempt = delivery.attempt + 1
    const giveUp = status === 'failed' && nextAttempt >= maxAttempts
    const finalStatus = status === 'delivered' ? 'delivered' : giveUp ? 'failed' : 'pending'
    await withTenant(deps.db, delivery.tenantId, (tx) =>
      tx
        .update(t.webhookDelivery)
        .set({
          status: finalStatus,
          attempt: nextAttempt,
          nextAttemptAt:
            status === 'delivered' || giveUp ? null : new Date(now.getTime() + 2 ** nextAttempt * 15_000),
          ...(lastError !== null ? { lastError } : {}),
        })
        .where(eq(t.webhookDelivery.deliveryId, delivery.deliveryId)),
    )
    return delivered + (status === 'delivered' ? 1 : 0)
  }, Promise.resolve(0))
  return due.length
}

export const publishTick = async (deps: PublisherDeps): Promise<void> => {
  try {
    await createDeliveriesForNewEvents(deps)
    await processDueDeliveries(deps)
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'outbox publisher tick failed',
    )
  }
}

export const startPublisherLoop = (deps: PublisherDeps, intervalMs = 2_000): (() => void) => {
  const timer = setInterval(() => void publishTick(deps), intervalMs)
  return () => clearInterval(timer)
}
