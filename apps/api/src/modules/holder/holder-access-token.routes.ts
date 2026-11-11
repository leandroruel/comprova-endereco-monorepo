import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
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

  /**
   * A emissão devolve um bearer token de uso único. Em `onSend` o header cobre
   * também respostas de erro (404/409/429/500), impedindo cache por proxy,
   * navegador ou CDN.
   */
  const noStore = async (
    _request: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
  ): Promise<unknown> => {
    reply.header('Cache-Control', 'no-store')
    return payload
  }

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
      onSend: [noStore],
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
