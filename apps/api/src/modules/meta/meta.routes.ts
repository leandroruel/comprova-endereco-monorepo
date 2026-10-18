import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance } from 'fastify'
import type { MetaControllerDeps } from './meta.controller.js'
import { makeMetaController } from './meta.controller.js'
import { MetaResponse } from './meta.schema.js'

export type MetaRoutesDeps = MetaControllerDeps

export const registerMetaRoutes = (instance: FastifyInstance, deps: MetaRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeMetaController(deps)

  app.get('/meta', { schema: { response: { 200: MetaResponse } } }, async () => controller.get())
}
