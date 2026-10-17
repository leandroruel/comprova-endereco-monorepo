import type { DeepEnrichDeps } from './deep-enrich.service.js'
import { deepEnrich } from './deep-enrich.service.js'
import { deepEnrichInputSchema, type DeepEnrichResult } from './deep-enrich.schema.js'

export type DeepActivities = {
  deepEnrichActivity: (input: unknown) => Promise<DeepEnrichResult>
}

/**
 * Fronteira do Temporal: valida a entrada (schema) e delega ao serviço.
 */
export const makeDeepEnrichActivity =
  (deps: DeepEnrichDeps) =>
  async (rawInput: unknown): Promise<DeepEnrichResult> =>
    deepEnrich(deps, deepEnrichInputSchema.parse(rawInput))
