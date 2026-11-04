import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from '@comprova/db'
import { ProblemSchema } from '@comprova/contracts'
import { makeM2MController } from './m2m.controller.js'
import { CreateApiKeyBody, ApiKeyIdParams, ApiKeyCreatedResponse, ApiKeyDtoSchema } from './m2m.schema.js'

export type M2MRoutesDeps = {
  readonly db: Db
  readonly apiKeyPepper: string
}

export const registerM2MRoutes = (instance: FastifyInstance, deps: M2MRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeM2MController(deps)

  app.post(
    '/m2m/api-keys',
    {
      schema: {
        body: CreateApiKeyBody,
        response: { 201: ApiKeyCreatedResponse },
      },
    },
    async (request, reply) => {
      return controller.create(
        {
          tenantId: request.body.tenantId,
          name: request.body.name,
          scopes: request.body.scopes,
          keyType: request.body.keyType,
          expiresInDays: request.body.expiresInDays,
          userId: request.sessionUser!.id,
        },
        reply,
      )
    },
  )

  app.get(
    '/m2m/api-keys',
    {
      schema: {
        querystring: z.object({ tenantId: z.string().uuid() }),
        response: { 200: ApiKeyDtoSchema },
      },
    },
    async (request, reply) => {
      return controller.list(request.query.tenantId, request.sessionUser!.id, reply)
    },
  )

  app.delete(
    '/m2m/api-keys/:apiKeyId',
    {
      schema: {
        params: ApiKeyIdParams,
        body: z.object({ tenantId: z.string().uuid() }),
        response: {
          200: z.object({ revoked: z.boolean() }),
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      return controller.revoke(request.body.tenantId, request.params.apiKeyId, request.sessionUser!.id, reply)
    },
  )
}
