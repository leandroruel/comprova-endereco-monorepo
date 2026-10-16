import { and, eq, withTenant } from '@comprova/db'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import { randomUUID } from 'node:crypto'
import { encryptSecret } from '../../shared/secretbox.js'
import type { CreateWebhookBody } from './webhooks.schema.js'
import { isSafeWebhookUrl, newWebhookSecret } from './webhook-crypto.js'

export interface WebhookServiceDeps {
  readonly db: Db
  readonly pepper: string
}

export interface CreatedWebhook {
  readonly endpointId: string
  readonly secret: string
}

export interface WebhookEndpoint {
  readonly endpointId: string
  readonly url: string
  readonly events: readonly string[]
  readonly active: boolean
}

export const createWebhook = async (
  deps: WebhookServiceDeps,
  tenantId: string,
  body: CreateWebhookBody,
): Promise<CreatedWebhook | null> => {
  if (!isSafeWebhookUrl(body.url)) return null
  const endpointId = randomUUID()
  const secret = newWebhookSecret()
  await withTenant(deps.db, tenantId, (tx) =>
    tx.insert(t.webhookEndpoint).values({
      endpointId,
      tenantId,
      url: body.url,
      secretEnc: encryptSecret(deps.pepper, secret),
      events: [...body.events],
      active: body.active,
    }),
  )
  return { endpointId, secret }
}

export const listWebhooks = async (
  deps: WebhookServiceDeps,
  tenantId: string,
): Promise<readonly WebhookEndpoint[]> => {
  const rows = await withTenant(deps.db, tenantId, (tx) =>
    tx
      .select({
        endpointId: t.webhookEndpoint.endpointId,
        url: t.webhookEndpoint.url,
        events: t.webhookEndpoint.events,
        active: t.webhookEndpoint.active,
      })
      .from(t.webhookEndpoint),
  )
  return rows.map((r) => ({
    endpointId: r.endpointId,
    url: r.url,
    events: r.events,
    active: r.active,
  }))
}

export const deleteWebhook = async (
  deps: WebhookServiceDeps,
  tenantId: string,
  endpointId: string,
): Promise<boolean> => {
  const deleted = await withTenant(deps.db, tenantId, (tx) =>
    tx
      .delete(t.webhookEndpoint)
      .where(and(eq(t.webhookEndpoint.endpointId, endpointId), eq(t.webhookEndpoint.tenantId, tenantId)))
      .returning({ endpointId: t.webhookEndpoint.endpointId }),
  )
  return deleted.length > 0
}
