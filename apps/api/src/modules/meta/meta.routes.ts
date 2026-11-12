import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance } from 'fastify'
import { requireReadScope, requireSessionOrM2MVerify } from '../../plugins/scope.js'
import type { Db } from '@comprova/db'
import { makeMetaController, type MetaControllerDeps } from './meta.controller.js'
import { MetaResponse } from './meta.schema.js'

export type MetaRoutesDeps = MetaControllerDeps & {
  readonly db: Db
}

export const registerMetaRoutes = (instance: FastifyInstance, deps: MetaRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeMetaController(deps)

  app.get(
    '/meta',
    {
      preHandler: [requireSessionOrM2MVerify(deps.db), requireReadScope],
      schema: { response: { 200: MetaResponse } },
    },
    async () => controller.get(),
  )
}
