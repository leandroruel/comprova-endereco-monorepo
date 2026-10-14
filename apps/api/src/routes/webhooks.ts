import { and, eq } from '@comprova/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { PROBLEM_CONTENT_TYPE, ProblemSchema, problems } from '@comprova/contracts'
import type { Db } from '@comprova/db'
import { withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { randomUUID } from 'node:crypto'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import { encryptSecret, isSafeWebhookUrl, newWebhookSecret } from '../webhooks.js'

const CreateWebhookSchema = z.object({
  url: z.url(),
  events: z.array(z.string().min(3)).min(1).default(['validation.completed']),
  active: z.boolean().default(true),
})

export interface WebhookRoutesDeps {
  readonly db: Db
  readonly pepper: string
}

export const registerWebhookRoutes = (instance: FastifyInstance, deps: WebhookRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()

  app.post(
    '/webhooks',
    {
      schema: {
        body: CreateWebhookSchema,
        response: { 200: z.object({ endpoint_id: z.uuid(), secret: z.string() }), 422: ProblemSchema },
      },
    },
    async (request, reply) => {
      const tenant = request.tenant
      if (tenant === undefined) throw new Error('tenant context missing')
      const body = request.body
      if (!isSafeWebhookUrl(body.url)) {
        return reply.code(422).type(PROBLEM_CONTENT_TYPE).send(problems.unprocessableAddress())
      }
      const endpointId = randomUUID()
      const secret = newWebhookSecret()
      await withTenant(deps.db, tenant.tenantId, (tx) =>
        tx.insert(t.webhookEndpoint).values({
          endpointId,
          tenantId: tenant.tenantId,
          url: body.url,
          secretEnc: encryptSecret(deps.pepper, secret),
          events: [...body.events],
          active: body.active,
        }),
      )
      return reply.send({ endpoint_id: endpointId, secret })
    },
  )

  app.get(
    '/webhooks',
    {
      schema: {
        response: {
          200: z.object({
            endpoints: z.array(
              z.object({
                endpoint_id: z.uuid(),
                url: z.string(),
                events: z.array(z.string()),
                active: z.boolean(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const tenant = request.tenant
      if (tenant === undefined) throw new Error('tenant context missing')
      const rows = await withTenant(deps.db, tenant.tenantId, (tx) =>
        tx
          .select({
            endpointId: t.webhookEndpoint.endpointId,
            url: t.webhookEndpoint.url,
            events: t.webhookEndpoint.events,
            active: t.webhookEndpoint.active,
          })
          .from(t.webhookEndpoint),
      )
      return {
        endpoints: rows.map((r) => ({
          endpoint_id: r.endpointId,
          url: r.url,
          events: r.events,
          active: r.active,
        })),
      }
    },
  )

  app.delete(
    '/webhooks/:id',
    {
      schema: {
        params: z.object({ id: z.uuid() }),
        response: { 200: z.object({ deleted: z.boolean() }), 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const tenant = request.tenant
      if (tenant === undefined) throw new Error('tenant context missing')
      const deleted = await withTenant(deps.db, tenant.tenantId, (tx) =>
        tx
          .delete(t.webhookEndpoint)
          .where(
            and(
              eq(t.webhookEndpoint.endpointId, request.params.id),
              eq(t.webhookEndpoint.tenantId, tenant.tenantId),
            ),
          )
          .returning({ endpointId: t.webhookEndpoint.endpointId }),
      )
      if (deleted.length === 0) {
        return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound('webhook'))
      }
      return reply.send({ deleted: true })
    },
  )
}
