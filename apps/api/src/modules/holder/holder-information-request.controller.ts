import type { FastifyReply } from 'fastify'
import type { Db } from '@comprova/db'
import { PROBLEM_CONTENT_TYPE, problem } from '@comprova/contracts'
import {
  type HolderInformationRequestCreatedResponseType,
  type HolderInformationRequestListResponseType,
  type HolderInformationRequestResponseType,
} from './holder-information-request.schema.js'
import { makeHolderInformationRequestService } from './holder-information-request.service.js'

export interface HolderInformationRequestControllerDeps {
  readonly db: Db
}

export const makeHolderInformationRequestController = (deps: HolderInformationRequestControllerDeps) => {
  const service = makeHolderInformationRequestService(deps)

  return {
    createHolderInformationRequest: async (
      actor: string,
      input: {
        readonly tenantId: string
        readonly holderId: string
        readonly type: string
        readonly purpose: string
        readonly items: unknown
        readonly expiresAt?: string
      },
      reply: FastifyReply,
    ): Promise<HolderInformationRequestCreatedResponseType | FastifyReply> => {
      try {
        const request = await service.createHolderInformationRequest(actor, input.tenantId, {
          holderId: input.holderId,
          type: input.type,
          purpose: input.purpose,
          items: input.items as never,
          expiresAt: input.expiresAt,
        })
        return reply.code(201).send(request)
      } catch (error) {
        if (error instanceof Error && error.message === 'holder not found') {
          return reply
            .code(404)
            .type(PROBLEM_CONTENT_TYPE)
            .send(problem(404, 'HOLDER_NOT_FOUND', 'Holder não encontrado'))
        }
        if (error instanceof Error && error.message.includes('prazo inválido')) {
          return reply
            .code(400)
            .type(PROBLEM_CONTENT_TYPE)
            .send(problem(400, 'INVALID_EXPIRES_AT', error.message))
        }
        return reply
          .code(500)
          .type(PROBLEM_CONTENT_TYPE)
          .send(problem(500, 'INTERNAL_ERROR', 'Erro ao criar solicitação de informações'))
      }
    },

    getHolderInformationRequest: async (
      actor: string,
      input: { readonly tenantId: string; readonly requestId: string },
      reply: FastifyReply,
    ): Promise<HolderInformationRequestResponseType | FastifyReply> => {
      const request = await service.getHolderInformationRequest(actor, input.tenantId, input.requestId)
      if (!request) {
        return reply
          .code(404)
          .type(PROBLEM_CONTENT_TYPE)
          .send(
            problem(404, 'HOLDER_INFORMATION_REQUEST_NOT_FOUND', 'Solicitação de informações não encontrada'),
          )
      }
      return reply.code(200).send(request)
    },

    listHolderInformationRequests: async (
      actor: string,
      input: {
        readonly tenantId: string
        readonly limit: number
        readonly offset: number
        readonly holderId?: string
        readonly state?: string
        readonly createdAfter?: string
        readonly createdBefore?: string
        readonly expiresBefore?: string
      },
      reply: FastifyReply,
    ): Promise<HolderInformationRequestListResponseType | FastifyReply> => {
      const result = await service.listHolderInformationRequests(actor, input.tenantId, {
        limit: input.limit,
        offset: input.offset,
        holderId: input.holderId,
        state: input.state,
        createdAfter: input.createdAfter,
        createdBefore: input.createdBefore,
        expiresBefore: input.expiresBefore,
      })
      return reply.code(200).send(result)
    },

    cancelHolderInformationRequest: async (
      actor: string,
      input: {
        readonly tenantId: string
        readonly requestId: string
        readonly toState: string
        readonly reason?: string
      },
      reply: FastifyReply,
    ): Promise<HolderInformationRequestResponseType | FastifyReply> => {
      try {
        const request = await service.cancelHolderInformationRequest(actor, input.tenantId, input.requestId, {
          reason: input.reason,
        })
        return reply.code(200).send(request)
      } catch (error) {
        if (error instanceof Error) {
          if (error.message === 'holder information request not found') {
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
          }
          if (error.message === 'concurrent state transition detected') {
            return reply
              .code(409)
              .type(PROBLEM_CONTENT_TYPE)
              .send(
                problem(
                  409,
                  'HOLDER_INFORMATION_REQUEST_CONCURRENT_TRANSITION',
                  'Conflito de transição simultânea: o estado da solicitação foi alterado por outra requisição',
                ),
              )
          }
          if (error.message.includes('invalid state transition')) {
            return reply
              .code(409)
              .type(PROBLEM_CONTENT_TYPE)
              .send(problem(409, 'INVALID_STATE_TRANSITION', error.message))
          }
        }
        return reply
          .code(500)
          .type(PROBLEM_CONTENT_TYPE)
          .send(problem(500, 'INTERNAL_ERROR', 'Erro ao cancelar solicitação de informações'))
      }
    },
  }
}
