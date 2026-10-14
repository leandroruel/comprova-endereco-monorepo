import { proxyActivities } from '@temporalio/workflow'
import type { DeepEnrichInput, DeepEnrichResult } from '../deep-enrich.js'

interface DeepActivities {
  deepEnrichActivity(input: DeepEnrichInput): Promise<DeepEnrichResult>
}

const enrich = proxyActivities<DeepActivities>({
  startToCloseTimeout: '45 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
  },
})

export async function deepValidationWorkflow(input: DeepEnrichInput): Promise<DeepEnrichResult> {
  return await enrich.deepEnrichActivity(input)
}
