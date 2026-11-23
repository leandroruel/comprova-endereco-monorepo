import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { PROBLEM_CONTENT_TYPE, problems } from '@comprova/contracts'
import { requireReadScope } from '../../plugins/scope.js'
import { verifierUserId } from '../../plugins/session.js'
import { makeStatsController, type StatsControllerDeps } from './stats.controller.js'
import { StatsResponse } from './stats.schema.js'

export type StatsRoutesDeps = StatsControllerDeps

const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
  if (request.sessionUser?.role !== 'admin') {
    return reply.code(403).type(PROBLEM_CONTENT_TYPE).send(problems.forbidden())
  }
}

export const registerStatsRoutes = (instance: FastifyInstance, deps: StatsRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeStatsController(deps)

  app.get(
    '/stats',
    {
      preHandler: [requireReadScope, requireAdmin],
      schema: { response: { 200: StatsResponse } },
    },
    // Sessão admin não é identidade de Verifier: sem filtro por `user_id`,
    // as estatísticas são do tenant (antes o id do admin zerava os números).
    async (request) => controller.get(request.tenant?.tenantId, verifierUserId(request)),
  )
}
