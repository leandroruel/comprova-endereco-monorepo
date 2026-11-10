import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import { PROBLEM_CONTENT_TYPE, problem } from '@comprova/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { makeHolderAccessController } from './holder-access.controller.js'
import {
  HolderAccessResponse,
  HolderDocumentParams,
  HolderItemIdParams,
  HolderSaveItemBody,
  type HolderAccessRoutesDeps,
} from './holder-access.schema.js'
import { isHolderTokenFormat } from './holder-token.js'
import type { HolderTokenContext } from './holder-access.service.js'
import { type HolderRateLimits } from '../../plugins/holder-rate-limit.js'
import { EvidenceMultipartError, readEvidenceFile } from '../validations/evidence-intake.multipart.js'

const headerToken = (request: FastifyRequest): string | undefined => {
  const value = request.headers['x-holder-token']
  if (typeof value === 'string' && value.length > 0) return value
  if (Array.isArray(value) && value.length > 0) return value[0]
  return undefined
}

export const registerHolderAccessRoutes = (
  instance: FastifyInstance,
  deps: HolderAccessRoutesDeps,
  rateLimits: HolderRateLimits,
): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeHolderAccessController(deps)

  const invalidToken = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const blocked = await rateLimits.invalid(request, reply)
    if (blocked !== undefined) return blocked as FastifyReply
    return reply
      .code(401)
      .type(PROBLEM_CONTENT_TYPE)
      .send(problem(401, 'HOLDER_TOKEN_INVALID', 'Token de acesso inválido ou ausente'))
  }

  const resolve = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<HolderTokenContext | FastifyReply> => {
    const token = headerToken(request)
    if (token === undefined || !isHolderTokenFormat(token)) {
      return invalidToken(request, reply)
    }
    const context = await controller.resolveToken(token)
    if (context === null) {
      return invalidToken(request, reply)
    }
    return context
  }

  const isReply = (value: unknown): value is FastifyReply =>
    typeof value === 'object' && value !== null && 'sent' in value

  app.get(
    '/holder-access',
    {
      preHandler: [rateLimits.ip, rateLimits.token],
      schema: { response: { 200: HolderAccessResponse } },
    },
    async (request, reply) => {
      const context = await resolve(request, reply)
      if (isReply(context)) return context
      return controller.getView(context, `holder-token:${context.tokenId}`, reply)
    },
  )

  app.put(
    '/holder-access/items/:itemId',
    {
      preHandler: [rateLimits.ip, rateLimits.token],
      schema: {
        params: HolderItemIdParams,
        body: HolderSaveItemBody,
        response: { 200: HolderAccessResponse },
      },
    },
    async (request, reply) => {
      const context = await resolve(request, reply)
      if (isReply(context)) return context
      return controller.saveItem(
        context,
        `holder-token:${context.tokenId}`,
        request.params.itemId,
        request.body.value,
        reply,
      )
    },
  )

  app.post(
    '/holder-access/items/:itemId/documents',
    {
      preHandler: [rateLimits.ip, rateLimits.token, rateLimits.upload],
      schema: { params: HolderItemIdParams },
    },
    async (request, reply) => {
      const context = await resolve(request, reply)
      if (isReply(context)) return context

      let file: Awaited<ReturnType<typeof readEvidenceFile>>
      try {
        file = await readEvidenceFile(request, deps.maxDocumentBytes)
      } catch (error) {
        if (error instanceof EvidenceMultipartError) {
          switch (error.reason) {
            case 'too_large':
              return reply
                .code(413)
                .type(PROBLEM_CONTENT_TYPE)
                .send(problem(413, 'EVIDENCE_TOO_LARGE', 'Arquivo excede o limite de upload'))
            case 'missing_file':
              return reply
                .code(400)
                .type(PROBLEM_CONTENT_TYPE)
                .send(problem(400, 'EVIDENCE_FILE_REQUIRED', 'Arquivo é obrigatório'))
            default:
              return reply
                .code(400)
                .type(PROBLEM_CONTENT_TYPE)
                .send(problem(400, 'INVALID_MULTIPART', 'Requisição multipart inválida'))
          }
        }
        throw error
      }

      return controller.uploadDocument(
        context,
        `holder-token:${context.tokenId}`,
        {
          itemId: request.params.itemId,
          data: file.data,
          declaredContentType: file.mimetype,
          originalFilename: file.filename,
        },
        reply,
      )
    },
  )

  app.delete(
    '/holder-access/items/:itemId/documents/:documentId',
    {
      preHandler: [rateLimits.ip, rateLimits.token],
      schema: { params: HolderDocumentParams },
    },
    async (request, reply) => {
      const context = await resolve(request, reply)
      if (isReply(context)) return context
      return controller.deleteDocument(
        context,
        `holder-token:${context.tokenId}`,
        { itemId: request.params.itemId, documentId: request.params.documentId },
        reply,
      )
    },
  )

  app.post(
    '/holder-access/submit',
    {
      preHandler: [rateLimits.ip, rateLimits.token],
      schema: { response: { 200: HolderAccessResponse } },
    },
    async (request, reply) => {
      const context = await resolve(request, reply)
      if (isReply(context)) return context
      return controller.submit(context, `holder-token:${context.tokenId}`, reply)
    },
  )
}
