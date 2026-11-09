import { z } from 'zod'

/**
 * Estados do ciclo de vida de uma solicitação de informações ao Holder.
 *
 * Nesta entrega (F4.1) somente `pending` (criação) e `cancelled` (cancelamento
 * pelo Verifier) são efetivamente transitados via API. `in_progress` e
 * `completed` são reservados para a F4.2, quando existir interação efetiva do
 * Holder. `expired` é aplicado quando o prazo de `expires_at` vence.
 */
export const HolderInformationRequestStateSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'cancelled',
  'expired',
])

export type HolderInformationRequestState = z.infer<typeof HolderInformationRequestStateSchema>

/**
 * Item individual de uma solicitação de informações.
 *
 * `itemId` deve ser estável e único dentro da solicitação. `description` é
 * obrigatória. `documentType` é opcional e identifica o tipo de documento
 * quando aplicável (ex.: `proof_of_address`).
 */
export const HolderInformationRequestItemSchema = z.object({
  itemId: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  required: z.boolean().default(true),
  documentType: z.string().min(1).max(100).optional(),
})

export type HolderInformationRequestItem = z.infer<typeof HolderInformationRequestItemSchema>

/**
 * Lista de itens solicitados. `itemId` deve ser único dentro da solicitação.
 */
export const HolderInformationRequestItemsSchema = z
  .array(HolderInformationRequestItemSchema)
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
  )

export type HolderInformationRequestItems = z.infer<typeof HolderInformationRequestItemsSchema>

export const CreateHolderInformationRequestRequestSchema = z.object({
  type: z.string().min(1).max(100),
  purpose: z.string().min(1).max(1000),
  items: HolderInformationRequestItemsSchema,
  expiresAt: z.string().datetime().optional(),
})

export type CreateHolderInformationRequestRequest = z.infer<
  typeof CreateHolderInformationRequestRequestSchema
>

export const HolderInformationRequestDtoSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  holderId: z.uuid(),
  type: z.string(),
  purpose: z.string(),
  items: z.array(HolderInformationRequestItemSchema),
  state: HolderInformationRequestStateSchema,
  expiresAt: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  expiredAt: z.string().nullable(),
})

export type HolderInformationRequestDto = z.infer<typeof HolderInformationRequestDtoSchema>

export const HolderInformationRequestListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  holderId: z.uuid().optional(),
  state: HolderInformationRequestStateSchema.optional(),
  createdAfter: z.string().datetime().optional(),
  createdBefore: z.string().datetime().optional(),
  expiresBefore: z.string().datetime().optional(),
})

export type HolderInformationRequestListQuery = z.infer<typeof HolderInformationRequestListQuerySchema>

export const HolderInformationRequestListResponseSchema = z.object({
  requests: z.array(HolderInformationRequestDtoSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
})

export type HolderInformationRequestListResponse = z.infer<typeof HolderInformationRequestListResponseSchema>

export const HolderInformationRequestTransitionRequestSchema = z.object({
  toState: z.enum(['cancelled']),
  reason: z.string().min(1).max(500).optional(),
})

export type HolderInformationRequestTransitionRequest = z.infer<
  typeof HolderInformationRequestTransitionRequestSchema
>

export const HolderInformationRequestNotFoundResponse = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
})

export type HolderInformationRequestNotFoundResponse = z.infer<
  typeof HolderInformationRequestNotFoundResponse
>

export const HolderInformationRequestInvalidTransitionResponse = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
})

export type HolderInformationRequestInvalidTransitionResponse = z.infer<
  typeof HolderInformationRequestInvalidTransitionResponse
>
