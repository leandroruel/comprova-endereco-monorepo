import type { Verdict } from '@comprova/core'
import { z } from 'zod'

export const deepEnrichInputSchema = z.object({
  tenantId: z.string(),
  validationId: z.string(),
  maxTier: z.number().optional(),
})

export type DeepEnrichInput = z.infer<typeof deepEnrichInputSchema>

export interface DeepEnrichResult {
  readonly status: 'completed' | 'partial' | 'blocked_quota'
  readonly verdict: Verdict
  readonly confidence: number
  readonly score: number
  readonly explanation: string
  readonly newSignals: number
  readonly t2Signals: number
}
