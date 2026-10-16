import type { Db } from '@comprova/db'
import { getStats } from './stats.service.js'

export interface StatsControllerDeps {
  readonly db: Db
}

export const makeStatsController = (deps: StatsControllerDeps) => ({
  get: async (tenantId: string | undefined, userId: string | null | undefined) => {
    if (tenantId === undefined) throw new Error('tenant context missing')
    return getStats(deps.db, tenantId, userId ?? null)
  },
})
