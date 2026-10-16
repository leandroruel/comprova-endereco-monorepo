import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance } from 'fastify'
import type { SubjectControllerDeps } from './subjects.controller.js'
import { makeSubjectController } from './subjects.controller.js'
import {
  SubjectErasureResponse,
  SubjectIdParams,
  SubjectNotFoundResponse,
  SubjectValidationsResponse,
} from './subjects.schema.js'

export type SubjectRoutesDeps = SubjectControllerDeps

export const registerSubjectRoutes = (instance: FastifyInstance, deps: SubjectRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeSubjectController(deps)

  app.get(
    '/subjects/:id/validations',
    {
      schema: {
        params: SubjectIdParams,
        response: { 200: SubjectValidationsResponse, 404: SubjectNotFoundResponse },
      },
    },
    async (request, reply) => controller.listValidations(request.tenant?.tenantId, request.params.id, reply),
  )

  app.delete(
    '/subjects/:id',
    {
      schema: {
        params: SubjectIdParams,
        response: { 200: SubjectErasureResponse, 404: SubjectNotFoundResponse },
      },
    },
    async (request, reply) =>
      controller.erase(request.tenant?.tenantId, request.tenant?.apiKeyId, request.params.id, reply),
  )
}
