import type { FastifyReply } from 'fastify'
import type { Db } from '@comprova/db'
import { PROBLEM_CONTENT_TYPE, problem, type KycProcessState } from '@comprova/contracts'
import type { z } from 'zod'
import {
  type HolderCreatedResponse,
  type HolderResponse,
  type HoldersListResponse,
  type KycProcessCreatedResponse,
  type KycProcessResponse,
  type KycProcessListResponse,
  type KycProcessTransitionResponse,
  type KycEventResponse,
} from './holder.schema.js'
import { makeHolderService } from './holder.service.js'

export type HolderCreatedResponseType = z.infer<typeof HolderCreatedResponse>
export type HolderResponseType = z.infer<typeof HolderResponse>
export type HoldersListResponseType = z.infer<typeof HoldersListResponse>
export type KycProcessCreatedResponseType = z.infer<typeof KycProcessCreatedResponse>
export type KycProcessResponseType = z.infer<typeof KycProcessResponse>
export type KycProcessListResponseType = z.infer<typeof KycProcessListResponse>
export type KycProcessTransitionResponseType = z.infer<typeof KycProcessTransitionResponse>
export type KycEventResponseType = z.infer<typeof KycEventResponse>

export interface HolderControllerDeps {
  readonly db: Db
}

export const makeHolderController = (deps: HolderControllerDeps) => {
  const service = makeHolderService(deps)

  return {
    createHolder: async (
      actor: string,
      input: {
        readonly tenantId: string
        readonly externalReference: string
        readonly name: string
        readonly documentHash: string
        readonly documentType: string
      },
      reply: FastifyReply,
    ): Promise<HolderCreatedResponseType | FastifyReply> => {
      try {
        const holder = await service.createHolder(actor, input.tenantId, {
          externalReference: input.externalReference,
          name: input.name,
          documentHash: input.documentHash,
          documentType: input.documentType,
        })
        return reply.code(201).send(holder)
      } catch (error) {
        if (error instanceof Error && error.message.includes('already exists')) {
          return reply
            .code(409)
            .type(PROBLEM_CONTENT_TYPE)
            .send(problem(409, 'HOLDER_ALREADY_EXISTS', 'Já existe um holder com esta referência externa'))
        }
        return reply
          .code(500)
          .type(PROBLEM_CONTENT_TYPE)
          .send(problem(500, 'INTERNAL_ERROR', 'Erro ao criar holder'))
      }
    },

    getHolder: async (
      actor: string,
      input: { readonly tenantId: string; readonly holderId: string },
      reply: FastifyReply,
    ): Promise<HolderResponseType | FastifyReply> => {
      const holder = await service.getHolder(actor, input.tenantId, input.holderId)
      if (!holder) {
        return reply
          .code(404)
          .type(PROBLEM_CONTENT_TYPE)
          .send(problem(404, 'HOLDER_NOT_FOUND', 'Holder não encontrado'))
      }
      return reply.code(200).send(holder)
    },

    listHolders: async (
      actor: string,
      input: { readonly tenantId: string; readonly limit: number; readonly offset: number },
      reply: FastifyReply,
    ): Promise<HoldersListResponseType | FastifyReply> => {
      const result = await service.listHolders(actor, input.tenantId, {
        limit: input.limit,
        offset: input.offset,
      })
      return reply.code(200).send(result)
    },

    updateHolder: async (
      actor: string,
      input: {
        readonly tenantId: string
        readonly holderId: string
        readonly name?: string
        readonly documentHash?: string
        readonly documentType?: string
      },
      reply: FastifyReply,
    ): Promise<HolderResponseType | FastifyReply> => {
      try {
        const holder = await service.updateHolder(actor, input.tenantId, input.holderId, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.documentHash !== undefined ? { documentHash: input.documentHash } : {}),
          ...(input.documentType !== undefined ? { documentType: input.documentType } : {}),
        })
        return reply.code(200).send(holder)
      } catch (error) {
        if (error instanceof Error && error.message === 'holder not found') {
          return reply
            .code(404)
            .type(PROBLEM_CONTENT_TYPE)
            .send(problem(404, 'HOLDER_NOT_FOUND', 'Holder não encontrado'))
        }
        return reply
          .code(500)
          .type(PROBLEM_CONTENT_TYPE)
          .send(problem(500, 'INTERNAL_ERROR', 'Erro ao atualizar holder'))
      }
    },

    createKycProcess: async (
      actor: string,
      input: {
        readonly tenantId: string
        readonly holderId: string
        readonly legalBasis: string
        readonly expiresAt?: string
      },
      reply: FastifyReply,
    ): Promise<KycProcessCreatedResponseType | FastifyReply> => {
      try {
        const process = await service.createKycProcess(actor, {
          holderId: input.holderId,
          legalBasis: input.legalBasis,
          expiresAt: input.expiresAt,
        })
        return reply.code(201).send(process)
      } catch (error) {
        if (error instanceof Error && error.message === 'holder not found') {
          return reply
            .code(404)
            .type(PROBLEM_CONTENT_TYPE)
            .send(problem(404, 'HOLDER_NOT_FOUND', 'Holder não encontrado'))
        }
        return reply
          .code(500)
          .type(PROBLEM_CONTENT_TYPE)
          .send(problem(500, 'INTERNAL_ERROR', 'Erro ao criar processo KYC'))
      }
    },

    getKycProcess: async (
      actor: string,
      input: { readonly tenantId: string; readonly kycProcessId: string },
      reply: FastifyReply,
    ): Promise<KycProcessResponseType | FastifyReply> => {
      const process = await service.getKycProcess(actor, input.tenantId, input.kycProcessId)
      if (!process) {
        return reply
          .code(404)
          .type(PROBLEM_CONTENT_TYPE)
          .send(problem(404, 'KYC_PROCESS_NOT_FOUND', 'Processo KYC não encontrado'))
      }
      return reply.code(200).send(process)
    },

    listKycProcesses: async (
      actor: string,
      input: {
        readonly tenantId: string
        readonly holderId: string
        readonly limit: number
        readonly offset: number
        readonly state?: string
      },
      reply: FastifyReply,
    ): Promise<KycProcessListResponseType | FastifyReply> => {
      const result = await service.listKycProcesses(actor, input.tenantId, input.holderId, {
        limit: input.limit,
        offset: input.offset,
        state: input.state,
      })
      return reply.code(200).send(result)
    },

    transitionKycProcess: async (
      actor: string,
      input: {
        readonly tenantId: string
        readonly kycProcessId: string
        readonly toState: string
        readonly reason?: string
      },
      reply: FastifyReply,
    ): Promise<KycProcessTransitionResponseType | FastifyReply> => {
      try {
        const process = await service.transitionKycProcess(actor, input.tenantId, input.kycProcessId, {
          toState: input.toState as unknown as KycProcessState,
          reason: input.reason,
        })
        return reply.code(200).send(process)
      } catch (error) {
        if (error instanceof Error) {
          if (error.message === 'KYC process not found') {
            return reply
              .code(404)
              .type(PROBLEM_CONTENT_TYPE)
              .send(problem(404, 'KYC_PROCESS_NOT_FOUND', 'Processo KYC não encontrado'))
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
          .send(problem(500, 'INTERNAL_ERROR', 'Erro ao transicionar KYC'))
      }
    },

    listKycEvents: async (
      actor: string,
      input: {
        readonly tenantId: string
        readonly kycProcessId: string
        readonly limit: number
        readonly offset: number
      },
      reply: FastifyReply,
    ): Promise<
      | {
          events: KycEventResponseType[]
          total: number
          limit: number
          offset: number
        }
      | FastifyReply
    > => {
      const result = await service.listKycEvents(actor, input.tenantId, input.kycProcessId, {
        limit: input.limit,
        offset: input.offset,
      })
      return reply.code(200).send(result)
    },
  }
}
