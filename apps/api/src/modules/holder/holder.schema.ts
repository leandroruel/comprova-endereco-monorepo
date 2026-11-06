import type { FastifyReply } from 'fastify'
import { z } from 'zod'
import { PROBLEM_CONTENT_TYPE, problem } from '@comprova/contracts'
import type { Db } from '@comprova/db'

export const HolderIdParams = z.object({
  holderId: z.string().uuid(),
})

export const KycProcessIdParams = z.object({
  kycProcessId: z.string().uuid(),
})

export const HolderListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export const KycProcessListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  state: z.enum(['pending', 'in_progress', 'approved', 'rejected', 'expired']).optional(),
})

export const HolderCreatedResponse = z.object({
  holderId: z.string().uuid(),
  tenantId: z.string().uuid(),
  externalReference: z.string(),
  name: z.string(),
  documentHash: z.string(),
  documentType: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const HolderResponse = HolderCreatedResponse

export const HoldersListResponse = z.object({
  holders: z.array(HolderCreatedResponse),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
})

export const KycProcessCreatedResponse = z.object({
  kycProcessId: z.string().uuid(),
  holderId: z.string().uuid(),
  tenantId: z.string().uuid(),
  state: z.string(),
  legalBasis: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
})

export const KycProcessResponse = KycProcessCreatedResponse

export const KycProcessListResponse = z.object({
  processes: z.array(KycProcessCreatedResponse),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
})

export const KycProcessTransitionResponse = KycProcessCreatedResponse

export const KycEventResponse = z.object({
  kycEventId: z.string().uuid(),
  kycProcessId: z.string().uuid(),
  tenantId: z.string().uuid(),
  eventType: z.string(),
  fromState: z.string().nullable(),
  toState: z.string(),
  actor: z.string(),
  details: z.record(z.string(), z.any()),
  createdAt: z.string().datetime(),
})

export const HolderNotFoundResponse = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
})

export const KycProcessNotFoundResponse = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
})

export const ProblemResponse = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  request_id: z.string().optional(),
})

export type HolderIdParams = z.infer<typeof HolderIdParams>
export type KycProcessIdParams = z.infer<typeof KycProcessIdParams>
export type HolderListQuery = z.infer<typeof HolderListQuery>
export type KycProcessListQuery = z.infer<typeof KycProcessListQuery>
export type HolderCreatedResponseType = z.infer<typeof HolderCreatedResponse>
export type HolderResponseType = z.infer<typeof HolderResponse>
export type HoldersListResponseType = z.infer<typeof HoldersListResponse>
export type KycProcessCreatedResponseType = z.infer<typeof KycProcessCreatedResponse>
export type KycProcessResponseType = z.infer<typeof KycProcessResponse>
export type KycProcessListResponseType = z.infer<typeof KycProcessListResponse>
export type KycProcessTransitionResponseType = z.infer<typeof KycProcessTransitionResponse>
export type KycEventResponseType = z.infer<typeof KycEventResponse>

export interface HolderRoutesDeps {
  readonly db: Db
}

export const sendProblem = (
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
