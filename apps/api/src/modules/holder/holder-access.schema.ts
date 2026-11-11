import type { FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  CreateHolderAccessTokenResponseSchema,
  HolderAccessRequestSchema,
  SaveHolderItemResponseRequestSchema,
} from '@comprova/contracts'
import type { Db } from '@comprova/db'
import type { Logger, Metrics } from '@comprova/observability'
import type { ObjectStore } from '@comprova/providers'
import { PROBLEM_CONTENT_TYPE, problem } from '@comprova/contracts'

export const HolderItemIdParams = z.object({
  itemId: z.string().min(1).max(100),
})

export const HolderDocumentParams = z.object({
  itemId: z.string().min(1).max(100),
  documentId: z.string().uuid(),
})

export const HolderSaveItemBody = SaveHolderItemResponseRequestSchema

export const HolderAccessResponse = HolderAccessRequestSchema

export const HolderInformationRequestAccessTokenParams = z.object({
  requestId: z.string().uuid(),
})

export const HolderInformationRequestAccessTokenIdParams = z.object({
  requestId: z.string().uuid(),
  tokenId: z.string().uuid(),
})

export const HolderAccessTokenCreatedResponse = CreateHolderAccessTokenResponseSchema

export type HolderAccessResponseType = z.infer<typeof HolderAccessResponse>
export type HolderAccessTokenCreatedResponseType = z.infer<typeof HolderAccessTokenCreatedResponse>

export interface HolderAccessRoutesDeps {
  readonly db: Db
  readonly store: ObjectStore
  readonly pepper: string
  readonly logger: Logger
  readonly metrics?: Metrics
  readonly maxDocumentBytes: number
}

export interface HolderAccessTokenRoutesDeps {
  readonly db: Db
  readonly pepper: string
  readonly logger: Logger
}

export const sendHolderProblem = (
  reply: FastifyReply,
  status: number,
  code: string,
  title: string,
  detail?: string,
): FastifyReply =>
  reply
    .code(status)
    .type(PROBLEM_CONTENT_TYPE)
    .send(problem(status, code, title, detail))
