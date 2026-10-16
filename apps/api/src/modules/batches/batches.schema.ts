import { ProblemSchema } from '@comprova/contracts'
import { z } from 'zod'

export const CreateBatchRequest = z.object({
  documents: z
    .array(
      z.object({
        type: z.enum(['CPF', 'CNPJ']),
        value: z.string().min(11).max(20),
      }),
    )
    .min(1)
    .max(1000),
  mode: z.enum(['fast', 'deep', 'auto']).default('fast'),
  legal_basis: z.enum(['FRAUD_PREVENTION', 'CONTRACT_EXECUTION', 'CONSENT']),
})
export type CreateBatchBody = z.infer<typeof CreateBatchRequest>

export const CreateBatchResponse = z.object({
  batch_id: z.string(),
  total_items: z.number().int(),
  status: z.string(),
})

export const BatchListResponse = z.object({
  batches: z.array(
    z.object({
      batch_id: z.string(),
      status: z.string(),
      total_items: z.number().int(),
      completed: z.number().int(),
      failed: z.number().int(),
      created_at: z.string(),
      completed_at: z.string().nullable(),
    }),
  ),
})

export const BatchIdParams = z.object({ id: z.string() })

export const BatchDetailsResponse = z.object({
  batch_id: z.string(),
  status: z.string(),
  total_items: z.number().int(),
  items: z.array(
    z.object({
      position: z.number().int(),
      doc_type: z.string(),
      status: z.string(),
      validation_id: z.string().nullable(),
      error_code: z.string().nullable(),
      verdict: z.string().nullable(),
      confidence: z.number().nullable(),
      explanation: z.string().nullable(),
    }),
  ),
})

export const BatchExportQuery = z.object({ format: z.enum(['csv', 'json']).default('csv') })
export const BatchProblemResponse = ProblemSchema
