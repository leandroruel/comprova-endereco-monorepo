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

export const HolderProcessingParams = z.object({
  requestId: z.string().uuid(),
})

export const HolderProcessingResponse = z.object({
  processingId: z.string().uuid(),
  holderInformationRequestId: z.string().uuid(),
  tenantId: z.string().uuid(),
  state: z.enum(['awaiting', 'processing', 'processed', 'partial', 'failed']),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  processedAt: z.string().nullable(),
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
export type HolderProcessingResponseType = z.infer<typeof HolderProcessingResponse>

export interface HolderSubmissionProcessingService {
  readonly getProcessing: (
    holderInformationRequestId: string,
    tenantId: string,
  ) => Promise<{
    readonly processingId: string
    readonly holderInformationRequestId: string
    readonly tenantId: string
    readonly state: string
    readonly attempts: number
    readonly lastError: string | null
    readonly createdAt: Date
    readonly updatedAt: Date
    readonly processedAt: Date | null
  } | null>
}

export interface HolderAccessRoutesDeps {
  readonly db: Db
  readonly store: ObjectStore
  readonly pepper: string
  readonly logger: Logger
  readonly metrics?: Metrics
  readonly maxDocumentBytes: number
  readonly processingService: HolderSubmissionProcessingService
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
