import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ApiKeyDto } from '@comprova/contracts'
import type { z } from 'zod'
import type {
  ApiKeyIdParams,
  ApiKeyCreatedResponse,
  M2MControllerDeps,
} from './m2m.schema.js'
import { sendProblem } from './m2m.schema.js'
import { makeM2MService } from './m2m.service.js'

export type ApiKeyCreatedResponseType = z.infer<typeof ApiKeyCreatedResponse>

export const makeM2MController = (deps: M2MControllerDeps) => {
  const service = makeM2MService(deps)

  return {
    create: async (
      request: any,
      reply: FastifyReply,
    ): Promise<ApiKeyCreatedResponseType | FastifyReply> => {
      try {
        const result = await service.createApiKey(request.tenantId, {
          name: request.name,
          scopes: request.scopes,
          keyType: request.keyType,
          expiresInDays: request.expiresInDays,
        }, request.userId)
        return reply.code(201).send(result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return sendProblem(reply, 500, 'INTERNAL_ERROR', message)
      }
    },

    list: async (
      tenantId: string,
      userId: string,
      reply: FastifyReply,
    ): Promise<{ apiKeys: ApiKeyDto[] } | FastifyReply> => {
      const apiKeys = await service.listApiKeys(tenantId, userId)
      return reply.code(200).send({ apiKeys })
    },

    revoke: async (
      tenantId: string,
      apiKeyId: string,
      userId: string,
      reply: FastifyReply,
    ): Promise<{ revoked: boolean } | FastifyReply> => {
      const revoked = await service.revokeApiKey(tenantId, apiKeyId, userId)

      if (!revoked) {
        return sendProblem(reply, 404, 'API_KEY_NOT_FOUND', 'Credencial não encontrada')
      }

      return reply.code(200).send({ revoked: true })
    },
  }
}
