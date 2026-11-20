import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { makeHolderInformationRequestController } from './holder-information-request.controller.js'
import { makeHolderInformationRequestService } from './holder-information-request.service.js'
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

  /**
   * F4.1 — cria uma solicitação vinculada a uma Validation e emite o token de
   * acesso público do Holder em uma única operação atômica.
   *
   * O corpo aceita os mesmos campos de criação mais o `holderId` (repetido para
   * clareza no corpo) e retorna o token opaco em texto claro (aparece apenas
   * nesta resposta, nunca é persistido).
   */
  app.post(
    '/holders/:holderId/information-requests/with-token',
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
        body: z.object({
          type: z.string().min(1).max(100),
          purpose: z.string().min(1).max(1000),
          items: z
            .array(
              z.object({
                itemId: z.string().min(1).max(100),
                description: z.string().min(1).max(500),
                required: z.boolean().default(true),
                documentType: z.string().min(1).max(100).optional(),
              }),
            )
            .min(1, 'Pelo menos um item deve ser informado')
            .max(50, 'Número máximo de itens excedido'),
          expiresAt: z.string().datetime().optional(),
          validationId: z.string().uuid().optional(),
        }),
        response: {
          201: z.object({
            request: z.object({
              id: z.string().uuid(),
              tenantId: z.string().uuid(),
              holderId: z.string().uuid(),
              type: z.string(),
              purpose: z.string(),
              state: z.string(),
              expiresAt: z.string().nullable(),
              validationId: z.string().uuid().nullable(),
              createdBy: z.string(),
              createdAt: z.string(),
              updatedAt: z.string(),
            }),
            tokenId: z.string().uuid(),
            token: z.string(),
            tokenExpiresAt: z.string(),
            tokenCreatedAt: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const service = makeHolderInformationRequestService({
        db: deps.db,
        pepper: deps.pepper,
        logger: deps.logger,
      })
      const result = await service.createHolderInformationRequestWithToken(
        getActor(request),
        getTenantId(request),
        {
          holderId: request.params.holderId,
          type: request.body.type,
          purpose: request.body.purpose,
          items: request.body.items,
          expiresAt: request.body.expiresAt,
          validationId: request.body.validationId,
        },
      )

      return reply.code(201).send({
        request: {
          id: result.request.id,
          tenantId: result.request.tenantId,
          holderId: result.request.holderId,
          type: result.request.type,
          purpose: result.request.purpose,
          state: result.request.state,
          expiresAt: result.request.expiresAt,
          validationId: result.request.validationId,
          createdBy: result.request.createdBy,
          createdAt: result.request.createdAt,
          updatedAt: result.request.updatedAt,
        },
        tokenId: result.tokenId,
        token: result.token,
        tokenExpiresAt: result.tokenExpiresAt.toISOString(),
        tokenCreatedAt: result.tokenCreatedAt.toISOString(),
      })
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
