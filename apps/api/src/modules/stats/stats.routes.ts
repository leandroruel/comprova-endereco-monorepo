import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance } from 'fastify'
import { requireReadScope } from '../../plugins/scope.js'
import type { StatsControllerDeps } from './stats.controller.js'
import { makeStatsController } from './stats.controller.js'
import { StatsResponse } from './stats.schema.js'

export type StatsRoutesDeps = StatsControllerDeps

export const registerStatsRoutes = (instance: FastifyInstance, deps: StatsRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeStatsController(deps)

  app.get(
    '/stats',
    { preHandler: requireReadScope, schema: { response: { 200: StatsResponse } } },
    async (request) => controller.get(request.tenant?.tenantId, request.sessionUser?.id),
  )
}
