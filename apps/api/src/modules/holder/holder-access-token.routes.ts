import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { makeHolderAccessTokenController } from './holder-access-token.controller.js'
import {
  HolderAccessTokenCreatedResponse,
  HolderInformationRequestAccessTokenIdParams,
  HolderInformationRequestAccessTokenParams,
  type HolderAccessTokenRoutesDeps,
} from './holder-access.schema.js'
import {
  requireScope,
  requireSessionOrM2M,
  requireSessionOrM2MVerify,
  requireTenantMatch,
} from '../../plugins/scope.js'

export const registerHolderAccessTokenRoutes = (
  instance: FastifyInstance,
  deps: HolderAccessTokenRoutesDeps,
): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeHolderAccessTokenController(deps)

  const getActor = (request: FastifyRequest): string => {
    if (request.sessionUser) return `session:${request.sessionUser.id}`
    if (request.tenant) return `api-key:${request.tenant.apiKeyId}`
    return 'system'
  }

  const getTenantId = (request: FastifyRequest): string => request.tenant?.tenantId ?? ''

  app.post(
    '/information-requests/:requestId/access-tokens',
    {
      preHandler: [
        requireSessionOrM2MVerify(deps.db),
        requireSessionOrM2M(deps.db),
        requireTenantMatch,
        requireScope('holders:write'),
      ],
      schema: {
        params: HolderInformationRequestAccessTokenParams,
        querystring: z.object({ tenantId: z.string().uuid() }),
        response: { 201: HolderAccessTokenCreatedResponse },
      },
    },
    async (request, reply) => {
      return controller.issueToken(
        getActor(request),
        { tenantId: getTenantId(request), requestId: request.params.requestId },
        reply,
      )
    },
  )

  app.delete(
    '/information-requests/:requestId/access-tokens/:tokenId',
    {
      preHandler: [
        requireSessionOrM2MVerify(deps.db),
        requireSessionOrM2M(deps.db),
        requireTenantMatch,
        requireScope('holders:write'),
      ],
      schema: {
        params: HolderInformationRequestAccessTokenIdParams,
        querystring: z.object({ tenantId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      return controller.revokeToken(
        getActor(request),
        {
          tenantId: getTenantId(request),
          requestId: request.params.requestId,
          tokenId: request.params.tokenId,
        },
        reply,
      )
    },
  )
}
