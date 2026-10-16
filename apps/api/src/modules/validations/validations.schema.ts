import { CreateValidationRequestSchema, ProblemSchema, ValidationDtoSchema } from '@comprova/contracts'
import { z } from 'zod'

export const GetValidationParams = z.object({ id: z.uuid() })
export const NotModifiedResponse = z.null()
export const CreateValidationHeaders = z.object({
  'idempotency-key': z.string().min(8).max(128).optional(),
})
export const ContestValidationRequest = z.object({ reason: z.string().min(10).max(2000) })
export const ContestValidationResponse = z.object({
  contested: z.boolean(),
  validation_id: z.uuid(),
})

export { CreateValidationRequestSchema, ProblemSchema, ValidationDtoSchema }
