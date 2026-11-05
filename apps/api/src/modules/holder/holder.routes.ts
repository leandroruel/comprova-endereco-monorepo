import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { makeHolderController } from './holder.controller.js'
import type { HolderRoutesDeps } from './holder.schema.js'
import {
  HolderIdParams,
  HolderListQuery,
  KycProcessListQuery,
  HolderCreatedResponse,
  HolderResponse,
  HoldersListResponse,
  KycProcessCreatedResponse,
  KycProcessResponse,
  KycProcessListResponse,
  KycProcessTransitionResponse,
  KycEventResponse,
  ProblemResponse,
  KycProcessNotFoundResponse,
} from './holder.schema.js'
import { requireSessionOrM2MVerify, requireScope } from '../../plugins/scope.js'

export const registerHolderRoutes = (instance: FastifyInstance, deps: HolderRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeHolderController(deps)

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
    '/holders',
    {
      preHandler: [requireSessionOrM2MVerify(deps.db), requireScope('holders:write')],
      schema: {
        querystring: z.object({ tenantId: z.string().uuid() }),
        body: z.object({
          externalReference: z.string().min(1).max(200),
          name: z.string().min(1).max(200),
          documentHash: z.string().regex(/^[0-9a-f]{64}$/),
          documentType: z.enum(['CPF', 'CNPJ']).default('CPF'),
        }),
        response: { 201: HolderCreatedResponse },
      },
    },
    async (request, reply) => {
      return controller.createHolder(
        getActor(request),
        {
          tenantId: getTenantId(request),
          externalReference: request.body.externalReference,
          name: request.body.name,
          documentHash: request.body.documentHash,
          documentType: request.body.documentType,
        },
        reply,
      )
    },
  )

  app.get(
    '/holders',
    {
      preHandler: [requireSessionOrM2MVerify(deps.db), requireScope('holders:read')],
      schema: {
        querystring: z.object({
          tenantId: z.string().uuid(),
          ...HolderListQuery.shape,
        }),
        response: { 200: HoldersListResponse },
      },
    },
    async (request, reply) => {
      return controller.listHolders(
        getActor(request),
        {
          tenantId: getTenantId(request),
          limit: request.query.limit,
          offset: request.query.offset,
        },
        reply,
      )
    },
  )

  app.get(
    '/holders/:holderId',
    {
      preHandler: [requireSessionOrM2MVerify(deps.db), requireScope('holders:read')],
      schema: {
        params: HolderIdParams,
        querystring: z.object({ tenantId: z.string().uuid() }),
        response: { 200: HolderResponse, 404: ProblemResponse },
      },
    },
    async (request, reply) => {
      return controller.getHolder(
        getActor(request),
        {
          tenantId: getTenantId(request),
          holderId: request.params.holderId,
        },
        reply,
      )
    },
  )

  app.patch(
    '/holders/:holderId',
    {
      preHandler: [requireSessionOrM2MVerify(deps.db), requireScope('holders:write')],
      schema: {
        params: HolderIdParams,
        querystring: z.object({ tenantId: z.string().uuid() }),
        body: z.object({
          name: z.string().min(1).max(200).optional(),
          documentHash: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
          documentType: z.enum(['CPF', 'CNPJ']).optional(),
        }),
        response: { 200: HolderResponse, 404: ProblemResponse },
      },
    },
    async (request, reply) => {
      return controller.updateHolder(
        getActor(request),
        {
          tenantId: getTenantId(request),
          holderId: request.params.holderId,
          name: request.body.name,
          documentHash: request.body.documentHash,
          documentType: request.body.documentType,
        },
        reply,
      )
    },
  )

  app.post(
    '/holders/:holderId/kyc',
    {
      preHandler: [requireSessionOrM2MVerify(deps.db), requireScope('kyc:write')],
      schema: {
        params: HolderIdParams,
        querystring: z.object({ tenantId: z.string().uuid() }),
        body: z.object({
          // holderId vem do path params, não do body, para evitar duplicidade.
          legalBasis: z.string().min(1).max(200),
          expiresAt: z.string().datetime().optional(),
        }),
        response: { 201: KycProcessCreatedResponse },
      },
    },
    async (request, reply) => {
      return controller.createKycProcess(
        getActor(request),
        {
          tenantId: getTenantId(request),
          holderId: request.params.holderId,
          legalBasis: request.body.legalBasis,
          expiresAt: request.body.expiresAt,
        },
        reply,
      )
    },
  )

  app.get(
    '/holders/:holderId/kyc',
    {
      preHandler: [requireSessionOrM2MVerify(deps.db), requireScope('kyc:read')],
      schema: {
        params: HolderIdParams,
        querystring: z.object({
          tenantId: z.string().uuid(),
          ...KycProcessListQuery.shape,
        }),
        response: { 200: KycProcessListResponse },
      },
    },
    async (request, reply) => {
      return controller.listKycProcesses(
        getActor(request),
        {
          tenantId: getTenantId(request),
          holderId: request.params.holderId,
          limit: request.query.limit,
          offset: request.query.offset,
          state: request.query.state,
        },
        reply,
      )
    },
  )

  app.get(
    '/holders/:holderId/kyc/:kycProcessId',
    {
      preHandler: [requireSessionOrM2MVerify(deps.db), requireScope('kyc:read')],
      schema: {
        params: z.object({
          holderId: z.string().uuid(),
          kycProcessId: z.string().uuid(),
        }),
        querystring: z.object({ tenantId: z.string().uuid() }),
        response: { 200: KycProcessResponse, 404: KycProcessNotFoundResponse },
      },
    },
    async (request, reply) => {
      return controller.getKycProcess(
        getActor(request),
        {
          tenantId: getTenantId(request),
          holderId: request.params.holderId,
          kycProcessId: request.params.kycProcessId,
        },
        reply,
      )
    },
  )

  app.post(
    '/holders/:holderId/kyc/:kycProcessId/transition',
    {
      preHandler: [requireSessionOrM2MVerify(deps.db), requireScope('kyc:write')],
      schema: {
        params: z.object({
          holderId: z.string().uuid(),
          kycProcessId: z.string().uuid(),
        }),
        querystring: z.object({ tenantId: z.string().uuid() }),
        body: z.object({
          toState: z.enum(['pending', 'in_progress', 'approved', 'rejected', 'expired']),
          reason: z.string().min(1).max(500).optional(),
        }),
        response: { 200: KycProcessTransitionResponse },
      },
    },
    async (request, reply) => {
      return controller.transitionKycProcess(
        getActor(request),
        {
          tenantId: getTenantId(request),
          holderId: request.params.holderId,
          kycProcessId: request.params.kycProcessId,
          toState: request.body.toState,
          reason: request.body.reason,
        },
        reply,
      )
    },
  )

  app.get(
    '/holders/:holderId/kyc/:kycProcessId/events',
    {
      preHandler: [requireSessionOrM2MVerify(deps.db), requireScope('kyc:read')],
      schema: {
        params: z.object({
          holderId: z.string().uuid(),
          kycProcessId: z.string().uuid(),
        }),
        querystring: z.object({
          tenantId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(1000).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: {
          200: z.object({
            events: z.array(KycEventResponse),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
    },
    async (request, reply) => {
      return controller.listKycEvents(
        getActor(request),
        {
          tenantId: getTenantId(request),
          holderId: request.params.holderId,
          kycProcessId: request.params.kycProcessId,
          limit: request.query.limit,
          offset: request.query.offset,
        },
        reply,
      )
    },
  )
}
