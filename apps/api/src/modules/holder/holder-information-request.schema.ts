import type { FastifyReply } from 'fastify'
import { z } from 'zod'
import { HolderInformationRequestStateSchema, PROBLEM_CONTENT_TYPE, problem } from '@comprova/contracts'
import type { Db } from '@comprova/db'
import type { Logger } from '@comprova/observability'

export const HolderInformationRequestIdParams = z.object({
  requestId: z.string().uuid(),
})

export const HolderInformationRequestListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  holderId: z.string().uuid().optional(),
  state: HolderInformationRequestStateSchema.optional(),
  createdAfter: z.string().datetime().optional(),
  createdBefore: z.string().datetime().optional(),
  expiresBefore: z.string().datetime().optional(),
})

export const CreateHolderInformationRequestBody = z.object({
  type: z.string().min(1).max(100),
  purpose: z.string().min(1).max(1000),
  items: z
    .array(
      z.object({
        itemId: z.string().min(1).max(100),
        description: z.string().min(1).max(500),
        required: z.boolean().default(true),
        documentType: z.string().min(1).max(100).optional(),
      }),
    )
    .min(1, 'Pelo menos um item deve ser informado')
    .max(50, 'Número máximo de itens excedido')
    .refine(
      (items) => {
        const ids = items.map((item) => item.itemId)
        return new Set(ids).size === ids.length
      },
      {
        message: 'itemId deve ser único dentro da solicitação',
        path: ['items'],
      },
    ),
  expiresAt: z.string().datetime().optional(),
  // PR 1: validation opcional que originou esta solicitação. Deve pertencer ao
  // mesmo tenant.
  validationId: z.string().uuid().optional(),
})

export const HolderInformationRequestTransitionBody = z.object({
  toState: z.enum(['cancelled']),
  reason: z.string().min(1).max(500).optional(),
})

export const HolderInformationRequestCreatedResponse = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  holderId: z.string().uuid(),
  type: z.string(),
  purpose: z.string(),
  items: z.array(
    z.object({
      itemId: z.string(),
      description: z.string(),
      required: z.boolean(),
      documentType: z.string().optional(),
    }),
  ),
  state: z.string(),
  expiresAt: z.string().nullable(),
  // PR 1: validation que originou esta solicitação, quando aplicável.
  validationId: z.string().uuid().nullable(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  cancelledAt: z.string().datetime().nullable(),
  expiredAt: z.string().datetime().nullable(),
})

export type HolderInformationRequestCreatedResponseType = z.infer<
  typeof HolderInformationRequestCreatedResponse
>

export const HolderInformationRequestResponse = HolderInformationRequestCreatedResponse

export type HolderInformationRequestResponseType = z.infer<typeof HolderInformationRequestResponse>

export const HolderInformationRequestListResponse = z.object({
  requests: z.array(HolderInformationRequestCreatedResponse),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
})

export type HolderInformationRequestListResponseType = z.infer<typeof HolderInformationRequestListResponse>

export type HolderInformationRequestIdParamsType = z.infer<typeof HolderInformationRequestIdParams>
export type HolderInformationRequestListQueryType = z.infer<typeof HolderInformationRequestListQuery>
export type CreateHolderInformationRequestBodyType = z.infer<typeof CreateHolderInformationRequestBody>
export type HolderInformationRequestTransitionBodyType = z.infer<
  typeof HolderInformationRequestTransitionBody
>

export interface HolderInformationRequestRoutesDeps {
  readonly db: Db
  readonly logger: Logger
}

export const sendHolderInformationRequestProblem = (
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
