import { IssuerKeyDocumentSchema } from '@comprova/credential'
import { PROBLEM_CONTENT_TYPE, ProblemSchema, problems } from '@comprova/contracts'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { IssuerControllerDeps } from './issuers.controller.js'
import { makeIssuerController } from './issuers.controller.js'

export type IssuerRoutesDeps = IssuerControllerDeps

/**
 * `scope` é o digest do tenant na URL do issuer (`issuerScopeOf`, 43 chars
 * base64url). O formato é validado aqui para não servir documento em path
 * arbitrário.
 */
const IssuerScopeParams = z.object({ scope: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })

export const registerIssuerRoutes = (instance: FastifyInstance, deps: IssuerRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeIssuerController(deps)

  app.get(
    '/issuers/:scope',
    {
      schema: {
        params: IssuerScopeParams,
        response: { 200: IssuerKeyDocumentSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const document = await controller.keyDocument(request.params.scope)
      if (document === null) {
        return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound('issuer'))
      }
      return reply.send(document)
    },
  )
}
