import { PROBLEM_CONTENT_TYPE, problems } from '@comprova/contracts'
import type { FastifyReply } from 'fastify'
import type { CreateWebhookBody } from './webhooks.schema.js'
import type { WebhookServiceDeps } from './webhooks.service.js'
import { createWebhook, deleteWebhook, listWebhooks } from './webhooks.service.js'

export interface WebhookController {
  readonly create: (
    tenantId: string | undefined,
    body: CreateWebhookBody,
    reply: FastifyReply,
  ) => Promise<FastifyReply | { endpoint_id: string; secret: string }>
  readonly list: (tenantId: string | undefined) => Promise<{
    endpoints: { endpoint_id: string; url: string; events: string[]; active: boolean }[]
  }>
  readonly remove: (
    tenantId: string | undefined,
    endpointId: string,
    reply: FastifyReply,
  ) => Promise<FastifyReply | { deleted: boolean }>
}

export const makeWebhookController = (deps: WebhookServiceDeps): WebhookController => ({
  create: async (tenantId, body, reply) => {
    if (tenantId === undefined) throw new Error('tenant context missing')
    const created = await createWebhook(deps, tenantId, body)
    if (created === null) {
      return reply.code(422).type(PROBLEM_CONTENT_TYPE).send(problems.unprocessableAddress())
    }
    return reply.send({ endpoint_id: created.endpointId, secret: created.secret })
  },

  list: async (tenantId) => {
    if (tenantId === undefined) throw new Error('tenant context missing')
    const endpoints = await listWebhooks(deps, tenantId)
    return {
      endpoints: endpoints.map((e) => ({
        endpoint_id: e.endpointId,
        url: e.url,
        events: [...e.events],
        active: e.active,
      })),
    }
  },

  remove: async (tenantId, endpointId, reply) => {
    if (tenantId === undefined) throw new Error('tenant context missing')
    const deleted = await deleteWebhook(deps, tenantId, endpointId)
    if (!deleted) {
      return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound('webhook'))
    }
    return reply.send({ deleted: true })
  },
})
