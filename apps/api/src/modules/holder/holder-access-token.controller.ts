import type { FastifyReply } from 'fastify'
import { PROBLEM_CONTENT_TYPE, problem } from '@comprova/contracts'
import { makeHolderAccessTokenService } from './holder-access-token.service.js'
import type { HolderAccessTokenRoutesDeps } from './holder-access.schema.js'

export const makeHolderAccessTokenController = (deps: HolderAccessTokenRoutesDeps) => {
  const service = makeHolderAccessTokenService({
    db: deps.db,
    pepper: deps.pepper,
    logger: deps.logger,
  })

  return {
    issueToken: async (
      actor: string,
      input: { readonly tenantId: string; readonly requestId: string },
      reply: FastifyReply,
    ): Promise<FastifyReply> => {
      try {
        const result = await service.issueToken(actor, input.tenantId, input.requestId)
        switch (result.kind) {
          case 'created':
            return reply.code(201).send({
              tokenId: result.tokenId,
              token: result.token,
              expiresAt: result.expiresAt.toISOString(),
              createdAt: result.createdAt.toISOString(),
            })
          case 'not_found':
            return reply
              .code(404)
              .type(PROBLEM_CONTENT_TYPE)
              .send(
                problem(
                  404,
                  'HOLDER_INFORMATION_REQUEST_NOT_FOUND',
                  'Solicitação de informações não encontrada',
                ),
              )
          case 'expired':
            return reply
              .code(409)
              .type(PROBLEM_CONTENT_TYPE)
              .send(problem(409, 'HOLDER_INFORMATION_REQUEST_EXPIRED', 'Solicitação de informações expirada'))
          case 'state':
            return reply
              .code(409)
              .type(PROBLEM_CONTENT_TYPE)
              .send(
                problem(
                  409,
                  'INVALID_STATE_TRANSITION',
                  `Não é possível emitir token no estado '${result.state}'`,
                ),
              )
          case 'limit':
            return reply
              .code(429)
              .type(PROBLEM_CONTENT_TYPE)
              .send(
                problem(
                  429,
                  'HOLDER_ACCESS_TOKEN_LIMIT',
                  'Limite de tokens ativos atingido para esta solicitação',
                ),
              )
        }
      } catch (error) {
        service.logError('issue', input.tenantId, error)
        return reply
          .code(500)
          .type(PROBLEM_CONTENT_TYPE)
          .send(problem(500, 'INTERNAL_ERROR', 'Erro ao emitir token de acesso'))
      }
    },

    revokeToken: async (
      actor: string,
      input: { readonly tenantId: string; readonly requestId: string; readonly tokenId: string },
      reply: FastifyReply,
    ): Promise<FastifyReply> => {
      try {
        const result = await service.revokeToken(actor, input.tenantId, input.requestId, input.tokenId)
        if (result.kind === 'not_found') {
          return reply
            .code(404)
            .type(PROBLEM_CONTENT_TYPE)
            .send(problem(404, 'HOLDER_ACCESS_TOKEN_NOT_FOUND', 'Token de acesso não encontrado'))
        }
        return reply.code(204).send()
      } catch (error) {
        service.logError('revoke', input.tenantId, error)
        return reply
          .code(500)
          .type(PROBLEM_CONTENT_TYPE)
          .send(problem(500, 'INTERNAL_ERROR', 'Erro ao revogar token de acesso'))
      }
    },
  }
}
