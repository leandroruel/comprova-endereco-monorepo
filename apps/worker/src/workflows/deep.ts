import { proxyActivities } from '@temporalio/workflow'
import type { DeepEnrichInput, DeepEnrichResult } from '../modules/deep-enrich/deep-enrich.schema.js'

interface DeepActivities {
  deepEnrichActivity(input: DeepEnrichInput): Promise<DeepEnrichResult>
}

const enrich = proxyActivities<DeepActivities>({
  startToCloseTimeout: '45 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    // `QuotaExceededError` (cota hard atingida) é um erro de negócio, não
    // transitório: retry não vai liberar cota, então não se repete a activity.
    // Falhas de banco/rede continuam sujeitas à política de retry acima.
    nonRetryableErrorTypes: ['QuotaExceededError'],
  },
})

export async function deepValidationWorkflow(input: DeepEnrichInput): Promise<DeepEnrichResult> {
  return await enrich.deepEnrichActivity(input)
}
