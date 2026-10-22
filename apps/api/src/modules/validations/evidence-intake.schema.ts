import { ProblemSchema } from '@comprova/contracts'
import { z } from 'zod'

export const EvidenceIntakeParams = z.object({ id: z.uuid() })

export const EvidenceIntakeHeaders = z.object({
  'idempotency-key': z.string().min(8).max(128).optional(),
})

export const EvidenceIntakeResponse = z.object({
  evidence_id: z.uuid(),
  artifact_id: z.uuid(),
  status: z.literal('pending'),
})

export { ProblemSchema }
