import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance } from 'fastify'
import { ProblemSchema } from '@comprova/contracts'
import { requireReadScope, requireWriteScope } from '../../plugins/scope.js'
import { makeWebhookController } from './webhooks.controller.js'
import type { WebhookServiceDeps } from './webhooks.service.js'
import {
  CreateWebhookResponse,
  CreateWebhookSchema,
  DeleteWebhookResponse,
  ListWebhooksResponse,
  WebhookIdParams,
} from './webhooks.schema.js'

export type WebhookRoutesDeps = WebhookServiceDeps

export const registerWebhookRoutes = (instance: FastifyInstance, deps: WebhookRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeWebhookController(deps)

  app.post(
    '/webhooks',
    {
      preHandler: requireWriteScope,
      schema: {
        body: CreateWebhookSchema,
        response: { 200: CreateWebhookResponse, 422: ProblemSchema },
      },
    },
    async (request, reply) => controller.create(request.tenant?.tenantId, request.body, reply),
  )

  app.get(
    '/webhooks',
    {
      preHandler: requireReadScope,
      schema: {
        response: { 200: ListWebhooksResponse },
      },
    },
    async (request) => controller.list(request.tenant?.tenantId),
  )

  app.delete(
    '/webhooks/:id',
    {
      preHandler: requireWriteScope,
      schema: {
        params: WebhookIdParams,
        response: { 200: DeleteWebhookResponse, 404: ProblemSchema },
      },
    },
    async (request, reply) => controller.remove(request.tenant?.tenantId, request.params.id, reply),
  )
}
