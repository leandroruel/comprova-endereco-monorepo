import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance } from 'fastify'
import type { BatchControllerDeps } from './batches.controller.js'
import { makeBatchController } from './batches.controller.js'
import {
  BatchDetailsResponse,
  BatchExportQuery,
  BatchIdParams,
  BatchListResponse,
  BatchProblemResponse,
  CreateBatchRequest,
  CreateBatchResponse,
} from './batches.schema.js'

export type BatchRoutesDeps = BatchControllerDeps

export const registerBatchRoutes = (instance: FastifyInstance, deps: BatchRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeBatchController(deps)

  app.post(
    '/batches',
    {
      schema: {
        body: CreateBatchRequest,
        response: { 202: CreateBatchResponse, 422: BatchProblemResponse },
      },
    },
    async (request, reply) =>
      controller.create(request.tenant?.tenantId, request.sessionUser?.id, request.body, reply),
  )

  app.get('/batches', { schema: { response: { 200: BatchListResponse } } }, async (request) =>
    controller.list(request.tenant?.tenantId, request.sessionUser?.id),
  )

  app.get(
    '/batches/:id',
    {
      schema: {
        params: BatchIdParams,
        response: { 200: BatchDetailsResponse, 404: BatchProblemResponse },
      },
    },
    async (request, reply) => controller.get(request.tenant?.tenantId, request.params.id, reply),
  )

  app.get(
    '/batches/:id/export',
    { schema: { params: BatchIdParams, querystring: BatchExportQuery } },
    async (request, reply) =>
      controller.export(request.tenant?.tenantId, request.params.id, request.query.format, reply),
  )
}
