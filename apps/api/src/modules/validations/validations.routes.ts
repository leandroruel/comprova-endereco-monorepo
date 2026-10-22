import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance } from 'fastify'
import { requireReadScope, requireWriteScope } from '../../plugins/scope.js'
import type { EvidenceIntakeControllerDeps } from './evidence-intake.controller.js'
import { makeEvidenceIntakeController } from './evidence-intake.controller.js'
import { EVIDENCE_MULTIPART_OVERHEAD_BYTES } from './evidence-intake.multipart.js'
import {
  EvidenceIntakeHeaders,
  EvidenceIntakeParams,
  EvidenceIntakeResponse,
} from './evidence-intake.schema.js'
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

export type ValidationRoutesDeps = ValidationControllerDeps & EvidenceIntakeControllerDeps

export const registerValidationRoutes = (instance: FastifyInstance, deps: ValidationRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeValidationController(deps)
  const evidenceController = makeEvidenceIntakeController(deps)

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

  app.post(
    '/validations/:id/evidence',
    {
      preHandler: requireWriteScope,
      // O parser de multipart tem seu próprio `fileSize`, mas o bodyLimit da
      // rota evita que o Fastify rejeite o envelope antes do parser. O overhead
      // cobre boundaries/headers, não o arquivo.
      bodyLimit: deps.evidenceMaxBytes + EVIDENCE_MULTIPART_OVERHEAD_BYTES,
      schema: {
        params: EvidenceIntakeParams,
        headers: EvidenceIntakeHeaders,
        response: {
          200: EvidenceIntakeResponse,
          201: EvidenceIntakeResponse,
          400: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          413: ProblemSchema,
          415: ProblemSchema,
          422: ProblemSchema,
          500: ProblemSchema,
          503: ProblemSchema,
        },
      },
    },
    async (request, reply) => evidenceController.upload(request.tenant, request, reply),
  )
}
