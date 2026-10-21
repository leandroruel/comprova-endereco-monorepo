import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance } from 'fastify'
import { requireReadScope, requireWriteScope } from '../../plugins/scope.js'
import type { ValidationControllerDeps } from './validations.controller.js'
import { makeValidationController } from './validations.controller.js'
import {
  ContestValidationRequest,
  ContestValidationResponse,
  CreateValidationHeaders,
  CreateValidationRequestSchema,
  GetValidationParams,
  NotModifiedResponse,
  ProblemSchema,
  SecuredVerifiableCredentialSchema,
  ValidationDtoSchema,
} from './validations.schema.js'

export type ValidationRoutesDeps = ValidationControllerDeps

export const registerValidationRoutes = (instance: FastifyInstance, deps: ValidationRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeValidationController(deps)

  app.get(
    '/validations/:id',
    {
      preHandler: requireReadScope,
      schema: {
        params: GetValidationParams,
        response: { 200: ValidationDtoSchema, 304: NotModifiedResponse, 404: ProblemSchema },
      },
    },
    async (request, reply) =>
      controller.get(request.tenant?.tenantId, request.params.id, request.headers['if-none-match'], reply),
  )

  app.post(
    '/validations',
    {
      preHandler: requireWriteScope,
      schema: {
        headers: CreateValidationHeaders,
        body: CreateValidationRequestSchema,
        response: {
          200: ValidationDtoSchema,
          202: ValidationDtoSchema,
          422: ProblemSchema,
        },
      },
    },
    async (request, reply) =>
      controller.create(
        request.tenant,
        request.sessionUser?.id,
        request.headers['idempotency-key'],
        request.body,
        reply,
      ),
  )

  app.post(
    '/validations/:id/contest',
    {
      preHandler: requireWriteScope,
      schema: {
        params: GetValidationParams,
        body: ContestValidationRequest,
        response: {
          200: ContestValidationResponse,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) =>
      controller.contest(
        request.tenant,
        request.params.id,
        request.body.reason,
        deps.fastPath.docHmacKey,
        reply,
      ),
  )

  app.post(
    '/validations/:id/credential',
    {
      preHandler: requireWriteScope,
      schema: {
        params: GetValidationParams,
        response: {
          200: SecuredVerifiableCredentialSchema,
          404: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => controller.credential(request.tenant, request.params.id, reply),
  )
}
