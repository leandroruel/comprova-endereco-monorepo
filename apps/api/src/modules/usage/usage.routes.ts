import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance } from 'fastify'
import { requireReadScope } from '../../plugins/scope.js'
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

export type UsageRoutesDeps = UsageControllerDeps

export const registerUsageRoutes = (instance: FastifyInstance, deps: UsageRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeUsageController(deps)

  app.get(
    '/usage/consumption',
    {
      preHandler: requireReadScope,
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
      preHandler: requireReadScope,
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
      preHandler: requireReadScope,
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
      preHandler: requireReadScope,
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
