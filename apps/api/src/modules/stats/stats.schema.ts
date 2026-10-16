import { z } from 'zod'

export const StatsResponse = z.object({
  total: z.number().int(),
  unique_documents: z.number().int(),
  by_doc_type: z.record(z.string(), z.number().int()),
  by_verdict: z.record(z.string(), z.number().int()),
  completed: z.number().int(),
  partial: z.number().int(),
  failed: z.number().int(),
  avg_confidence: z.number().min(0).max(1),
  avg_score: z.number(),
})
