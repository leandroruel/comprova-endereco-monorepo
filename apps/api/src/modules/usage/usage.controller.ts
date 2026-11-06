import type { Db } from '@comprova/db'
import { makeUsageService } from './usage.service.js'
import type { UsageConsumptionQuery, UsageEventsQuery } from './usage.schema.js'

export interface UsageControllerDeps {
  readonly db: Db
}

export const makeUsageController = (deps: UsageControllerDeps) => {
  const service = makeUsageService(deps)

  return {
    getConsumption: async (tenantId: string, query: UsageConsumptionQuery) => {
      return service.getConsumption(tenantId, query)
    },

    getQuota: async (tenantId: string) => {
      return service.getQuota(tenantId)
    },

    getEvents: async (tenantId: string, query: UsageEventsQuery) => {
      return service.getEvents(tenantId, query)
    },

    reconcile: async (tenantId: string, periodStart?: string, periodEnd?: string) => {
      return service.reconcile(tenantId, periodStart, periodEnd)
    },
  }
}
