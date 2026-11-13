import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { makeHolderInformationRequestController } from './holder-information-request.controller.js'
import {
  HolderInformationRequestIdParams,
  HolderInformationRequestListQuery,
  CreateHolderInformationRequestBody,
  HolderInformationRequestTransitionBody,
  HolderInformationRequestCreatedResponse,
  HolderInformationRequestResponse,
  HolderInformationRequestListResponse,
  type HolderInformationRequestRoutesDeps,
} from './holder-information-request.schema.js'
import {
  requireSessionOrM2M,
  requireSessionOrM2MVerify,
  requireTenantMatch,
  requireScope,
} from '../../plugins/scope.js'

export const registerHolderInformationRequestRoutes = (
  instance: FastifyInstance,
  deps: HolderInformationRequestRoutesDeps,
): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeHolderInformationRequestController(deps)

  const getActor = (request: FastifyRequest): string => {
    if (request.sessionUser) {
      return `session:${request.sessionUser.id}`
    }
    if (request.tenant) {
      return `api-key:${request.tenant.apiKeyId}`
    }
    return 'system'
  }

  const getTenantId = (request: FastifyRequest): string => {
    // O tenant vem exclusivamente do contexto autenticado (definido por
    // requireSessionOrM2MVerify). Nunca de parâmetros ou payload do cliente.
    return request.tenant?.tenantId ?? ''
  }

  app.post(
    '/holders/:holderId/information-requests',
    {
      preHandler: [
        requireSessionOrM2MVerify(deps.db),
        requireSessionOrM2M(deps.db),
        requireTenantMatch,
        requireScope('holders:write'),
      ],
      schema: {
        params: z.object({
          holderId: z.string().uuid(),
        }),
        querystring: z.object({ tenantId: z.string().uuid() }),
        body: CreateHolderInformationRequestBody,
        response: { 201: HolderInformationRequestCreatedResponse },
      },
    },
    async (request, reply) => {
      return controller.createHolderInformationRequest(
        getActor(request),
        {
          tenantId: getTenantId(request),
          holderId: request.params.holderId,
          type: request.body.type,
          purpose: request.body.purpose,
          items: request.body.items,
          expiresAt: request.body.expiresAt,
          // PR 1: vinculação opcional à validation.
          validationId: request.body.validationId,
        },
        reply,
      )
    },
  )

  app.get(
    '/holders/:holderId/information-requests',
    {
      preHandler: [
        requireSessionOrM2MVerify(deps.db),
        requireSessionOrM2M(deps.db),
        requireTenantMatch,
        requireScope('holders:read'),
      ],
      schema: {
        params: z.object({
          holderId: z.string().uuid(),
        }),
        querystring: z.object({
          tenantId: z.string().uuid(),
          ...HolderInformationRequestListQuery.shape,
        }),
        response: { 200: HolderInformationRequestListResponse },
      },
    },
    async (request, reply) => {
      return controller.listHolderInformationRequests(
        getActor(request),
        {
          tenantId: getTenantId(request),
          limit: request.query.limit,
          offset: request.query.offset,
          holderId: request.params.holderId,
          state: request.query.state,
          createdAfter: request.query.createdAfter,
          createdBefore: request.query.createdBefore,
          expiresBefore: request.query.expiresBefore,
        },
        reply,
      )
    },
  )

  app.get(
    '/information-requests',
    {
      preHandler: [
        requireSessionOrM2MVerify(deps.db),
        requireSessionOrM2M(deps.db),
        requireTenantMatch,
        requireScope('holders:read'),
      ],
      schema: {
        querystring: z.object({
          tenantId: z.string().uuid(),
          ...HolderInformationRequestListQuery.shape,
        }),
        response: { 200: HolderInformationRequestListResponse },
      },
    },
    async (request, reply) => {
      return controller.listHolderInformationRequests(
        getActor(request),
        {
          tenantId: getTenantId(request),
          limit: request.query.limit,
          offset: request.query.offset,
          holderId: request.query.holderId,
          state: request.query.state,
          createdAfter: request.query.createdAfter,
          createdBefore: request.query.createdBefore,
          expiresBefore: request.query.expiresBefore,
        },
        reply,
      )
    },
  )

  app.get(
    '/information-requests/:requestId',
    {
      preHandler: [
        requireSessionOrM2MVerify(deps.db),
        requireSessionOrM2M(deps.db),
        requireTenantMatch,
        requireScope('holders:read'),
      ],
      schema: {
        params: HolderInformationRequestIdParams,
        querystring: z.object({ tenantId: z.string().uuid() }),
        response: {
          200: HolderInformationRequestResponse,
          404: z.object({
            type: z.string(),
            title: z.string(),
            status: z.number().int(),
            code: z.string(),
            detail: z.string().optional(),
          }),
        },
      },
    },
    async (request, reply) => {
      return controller.getHolderInformationRequest(
        getActor(request),
        {
          tenantId: getTenantId(request),
          requestId: request.params.requestId,
        },
        reply,
      )
    },
  )

  app.post(
    '/information-requests/:requestId/cancel',
    {
      preHandler: [
        requireSessionOrM2MVerify(deps.db),
        requireSessionOrM2M(deps.db),
        requireTenantMatch,
        requireScope('holders:write'),
      ],
      schema: {
        params: HolderInformationRequestIdParams,
        querystring: z.object({ tenantId: z.string().uuid() }),
        body: HolderInformationRequestTransitionBody,
        response: {
          200: HolderInformationRequestResponse,
          404: z.object({
            type: z.string(),
            title: z.string(),
            status: z.number().int(),
            code: z.string(),
            detail: z.string().optional(),
          }),
          409: z.object({
            type: z.string(),
            title: z.string(),
            status: z.number().int(),
            code: z.string(),
            detail: z.string().optional(),
          }),
        },
      },
    },
    async (request, reply) => {
      return controller.cancelHolderInformationRequest(
        getActor(request),
        {
          tenantId: getTenantId(request),
          requestId: request.params.requestId,
          toState: request.body.toState,
          reason: request.body.reason,
        },
        reply,
      )
    },
  )
}
