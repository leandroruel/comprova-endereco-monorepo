import type { FastifyReply } from 'fastify'
import type { ApiKeyDto, CreateApiKeyRequest } from '@comprova/contracts'
import { PROBLEM_CONTENT_TYPE, problem } from '@comprova/contracts'
import type { z } from 'zod'
import type { ApiKeyCreatedResponse, M2MControllerDeps } from './m2m.schema.js'
import { sendProblem } from './m2m.schema.js'
import { makeM2MService, AuthorizationError } from './m2m.service.js'

export type ApiKeyCreatedResponseType = z.infer<typeof ApiKeyCreatedResponse>

interface CreateApiKeyInput {
  readonly tenantId: string
  readonly userId: string
  readonly name: CreateApiKeyRequest['name']
  readonly scopes: CreateApiKeyRequest['scopes']
  readonly keyType: CreateApiKeyRequest['keyType']
  readonly expiresInDays: CreateApiKeyRequest['expiresInDays']
}

export const makeM2MController = (deps: M2MControllerDeps) => {
  const service = makeM2MService(deps)

  return {
    create: async (
      request: CreateApiKeyInput,
      reply: FastifyReply,
    ): Promise<ApiKeyCreatedResponseType | FastifyReply> => {
      try {
        const expiresInDays = request.expiresInDays
        const expiresAt = expiresInDays
          ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
          : undefined

        const result = await service.createApiKey(request.tenantId, request.userId, {
          name: request.name,
          scopes: request.scopes,
          keyType: request.keyType,
          expiresAt,
        })
        return reply.code(201).send({
          apiKey: {
            apiKeyId: result.apiKeyId,
            tenantId: request.tenantId,
            keyPrefix: result.keyPrefix,
            scopes: request.scopes,
            keyType: request.keyType,
            revokedAt: null,
            lastUsedAt: null,
            createdAt: new Date().toISOString(),
          },
          secret: result.secret,
        })
      } catch (error) {
        if (error instanceof AuthorizationError) {
          return reply
            .code(403)
            .type(PROBLEM_CONTENT_TYPE)
            .send(problem(403, 'FORBIDDEN', error.message))
        }
        if (error instanceof Error && error.message.includes('scope')) {
          return reply
            .code(400)
            .type(PROBLEM_CONTENT_TYPE)
            .send(problem(400, 'INVALID_SCOPE', error.message))
        }
        return sendProblem(reply, 500, 'INTERNAL_ERROR', 'Erro ao criar credencial')
      }
    },

    list: async (
      tenantId: string,
      userId: string,
      reply: FastifyReply,
    ): Promise<{ apiKeys: ApiKeyDto[] } | FastifyReply> => {
      try {
        // O tenantId é obtido do contexto autenticado (definido por
        // requireSessionOrM2MVerify), nunca do parâmetro do cliente.
        const apiKeys = await service.listApiKeys(tenantId, userId)
        return reply.code(200).send({ apiKeys })
      } catch (error) {
        if (error instanceof AuthorizationError) {
          return reply
            .code(403)
            .type(PROBLEM_CONTENT_TYPE)
            .send(problem(403, 'FORBIDDEN', error.message))
        }
        return sendProblem(reply, 500, 'INTERNAL_ERROR', 'Erro ao listar credenciais')
      }
    },

    revoke: async (
      tenantId: string,
      apiKeyId: string,
      userId: string,
      reply: FastifyReply,
    ): Promise<{ revoked: boolean } | FastifyReply> => {
      try {
        const revoked = await service.revokeApiKey(apiKeyId, tenantId, userId)

        if (!revoked) {
          return sendProblem(reply, 404, 'API_KEY_NOT_FOUND', 'Credencial não encontrada')
        }

        return reply.code(200).send({ revoked: true })
      } catch (error) {
        if (error instanceof AuthorizationError) {
          return reply
            .code(403)
            .type(PROBLEM_CONTENT_TYPE)
            .send(problem(403, 'FORBIDDEN', error.message))
        }
        return sendProblem(reply, 500, 'INTERNAL_ERROR', 'Erro ao revogar credencial')
      }
    },
  }
}
