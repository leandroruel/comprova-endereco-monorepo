import { z } from 'zod'

export const KycProcessStateSchema = z.enum(['pending', 'in_progress', 'approved', 'rejected', 'expired'])

export type KycProcessState = z.infer<typeof KycProcessStateSchema>

export const KycEventTypeSchema = z.enum(['created', 'state_transitioned', 'document_added'])

export type KycEventType = z.infer<typeof KycEventTypeSchema>

export const CreateKycProcessRequestSchema = z.object({
  holderId: z.uuid(),
  legalBasis: z.string().min(1).max(200),
  expiresAt: z.string().datetime().optional(),
})

export type CreateKycProcessRequest = z.infer<typeof CreateKycProcessRequestSchema>

export const KycProcessDtoSchema = z.object({
  kycProcessId: z.uuid(),
  holderId: z.uuid(),
  tenantId: z.uuid(),
  state: KycProcessStateSchema,
  legalBasis: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string().nullable(),
})

export type KycProcessDto = z.infer<typeof KycProcessDtoSchema>

export const KycProcessListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  state: KycProcessStateSchema.optional(),
})

export type KycProcessListQuery = z.infer<typeof KycProcessListQuerySchema>

export const KycProcessListResponseSchema = z.object({
  processes: z.array(KycProcessDtoSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
})

export type KycProcessListResponse = z.infer<typeof KycProcessListResponseSchema>

export const KycProcessTransitionRequestSchema = z.object({
  toState: KycProcessStateSchema,
  reason: z.string().min(1).max(500).optional(),
})

export type KycProcessTransitionRequest = z.infer<typeof KycProcessTransitionRequestSchema>

export const KycEventDtoSchema = z.object({
  kycEventId: z.uuid(),
  kycProcessId: z.uuid(),
  tenantId: z.uuid(),
  eventType: KycEventTypeSchema,
  fromState: KycProcessStateSchema.nullable(),
  toState: KycProcessStateSchema,
  actor: z.string(),
  details: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
})

export type KycEventDto = z.infer<typeof KycEventDtoSchema>
