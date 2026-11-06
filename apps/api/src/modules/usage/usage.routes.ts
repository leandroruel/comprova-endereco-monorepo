import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance } from 'fastify'
import { requireReadScope, requireSessionOrM2MVerify, requireTenantMatch } from '../../plugins/scope.js'
import type { Db } from '@comprova/db'
import type { UsageControllerDeps } from './usage.controller.js'
import { makeUsageController } from './usage.controller.js'
import {
  UsageConsumptionQuerySchema,
  UsageConsumptionResponseSchema,
  UsageEventsQuerySchema,
  UsageEventsResponseSchema,
  UsageQuotaResponseSchema,
  UsageReconciliationResponseSchema,
} from './usage.schema.js'

export type UsageRoutesDeps = UsageControllerDeps & { readonly db: Db }

export const registerUsageRoutes = (instance: FastifyInstance, deps: UsageRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeUsageController(deps)
  const authSessionOrM2M = requireSessionOrM2MVerify(deps.db)

  app.get(
    '/usage/consumption',
    {
      preHandler: [authSessionOrM2M, requireReadScope, requireTenantMatch],
      schema: {
        querystring: UsageConsumptionQuerySchema,
        response: { 200: UsageConsumptionResponseSchema },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenant?.tenantId ?? ''
      return reply.code(200).send(await controller.getConsumption(tenantId, request.query))
    },
  )

  app.get(
    '/usage/quota',
    {
      preHandler: [authSessionOrM2M, requireReadScope],
      schema: {
        response: { 200: UsageQuotaResponseSchema },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenant?.tenantId ?? ''
      return reply.code(200).send(await controller.getQuota(tenantId))
    },
  )

  app.get(
    '/usage/events',
    {
      preHandler: [authSessionOrM2M, requireReadScope, requireTenantMatch],
      schema: {
        querystring: UsageEventsQuerySchema,
        response: { 200: UsageEventsResponseSchema },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenant?.tenantId ?? ''
      return reply.code(200).send(await controller.getEvents(tenantId, request.query))
    },
  )

  app.get(
    '/usage/reconcile',
    {
      preHandler: [authSessionOrM2M, requireReadScope, requireTenantMatch],
      schema: {
        querystring: UsageConsumptionQuerySchema,
        response: { 200: UsageReconciliationResponseSchema },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenant?.tenantId ?? ''
      const result = await controller.reconcile(tenantId, request.query.periodStart, request.query.periodEnd)
      return reply.code(200).send(result)
    },
  )
}
