import type { EvidenceWriter } from '@comprova/checkers'
import { z } from 'zod'

export const evidenceWriteSchema = z.object({
  kind: z.enum(['street_view_image', 'vlm_output']),
  provider: z.string(),
  data: z.instanceof(Uint8Array),
  contentType: z.string(),
  capturedAt: z.date().nullable(),
  retentionDays: z.number(),
  detail: z.record(z.string(), z.unknown()),
})

export type EvidenceWrite = z.infer<typeof evidenceWriteSchema>

export type { EvidenceWriter }
