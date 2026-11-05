import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from '@comprova/db'
import { ProblemSchema } from '@comprova/contracts'
import { makeM2MController } from './m2m.controller.js'
import { ApiKeyIdParams, ApiKeyCreatedResponse, ApiKeyDtoSchema } from './m2m.schema.js'
import { requireSessionOrM2MVerify, requireKeyType, requireScope } from '../../plugins/scope.js'

export type M2MRoutesDeps = {
  readonly db: Db
  readonly apiKeyPepper: string
}

export const registerM2MRoutes = (instance: FastifyInstance, deps: M2MRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeM2MController(deps)

  // Rotas de gestão de API keys: exigem sessão de usuário (ou M2M verify),
  // chave do tipo 'user' (não M2M) e scope keys:write. O tenant vem do
  // contexto autenticado, nunca do body ou query do cliente.
  app.post(
    '/m2m/api-keys',
    {
      preHandler: [requireSessionOrM2MVerify(deps.db), requireKeyType('user'), requireScope('keys:write')],
      schema: {
        querystring: z.object({ tenantId: z.string().uuid() }),
        body: z.object({
          name: z.string().min(1).max(100),
          scopes: z.array(z.string()).default(['validate:read', 'validate:write']),
          keyType: z.enum(['user', 'm2m']).default('m2m'),
          expiresInDays: z.number().int().min(1).max(3650).optional(),
        }),
        response: { 201: ApiKeyCreatedResponse },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenant?.tenantId ?? ''
      return controller.create(
        {
          tenantId,
          name: request.body.name,
          scopes: request.body.scopes,
          keyType: request.body.keyType,
          expiresInDays: request.body.expiresInDays,
          userId: request.sessionUser?.id ?? '',
        },
        reply,
      )
    },
  )

  app.get(
    '/m2m/api-keys',
    {
      preHandler: [requireSessionOrM2MVerify(deps.db), requireKeyType('user'), requireScope('keys:write')],
      schema: {
        querystring: z.object({ tenantId: z.string().uuid() }),
        response: { 200: ApiKeyDtoSchema },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenant?.tenantId ?? ''
      return controller.list(tenantId, request.sessionUser?.id ?? '', reply)
    },
  )

  app.delete(
    '/m2m/api-keys/:apiKeyId',
    {
      preHandler: [requireSessionOrM2MVerify(deps.db), requireKeyType('user'), requireScope('keys:write')],
      schema: {
        params: ApiKeyIdParams,
        querystring: z.object({ tenantId: z.string().uuid() }),
        response: {
          200: z.object({ revoked: z.boolean() }),
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenant?.tenantId ?? ''
      return controller.revoke(tenantId, request.params.apiKeyId, request.sessionUser?.id ?? '', reply)
    },
  )
}
