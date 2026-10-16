import { ProblemSchema } from '@comprova/contracts'
import { z } from 'zod'

export const SubjectIdParams = z.object({ id: z.uuid() })

export const SubjectValidationsResponse = z.object({
  subject_id: z.uuid(),
  validations: z.array(
    z.object({
      validation_id: z.uuid(),
      status: z.string(),
      verdict: z.string().nullable(),
      created_at: z.string(),
      expires_at: z.string(),
      legal_basis: z.string(),
      consent_ref: z.string().nullable(),
    }),
  ),
})

export const SubjectErasureResponse = z.object({
  erased: z.boolean(),
  validations_removed: z.number().int(),
})

export const SubjectNotFoundResponse = ProblemSchema
