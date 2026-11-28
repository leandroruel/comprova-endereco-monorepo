import type { ProviderRegistry } from '@comprova/billing-core'
import type { Db } from '@comprova/db'
import type { NormalizedWebhookEvent } from '@comprova/billing-core'
import { CustomerService } from '@comprova/billing-core'
import { InvoiceService } from '@comprova/billing-core'
import { SubscriptionService } from '@comprova/billing-core'
import { BillingPlanService } from '@comprova/billing-core'

export interface BillingServiceDeps {
  readonly db: Db
  readonly providerRegistry: ProviderRegistry
}

export const processStripeWebhook = async (
  deps: BillingServiceDeps,
  normalizedEvent: NormalizedWebhookEvent,
): Promise<void> => {
  const customerService = new CustomerService(deps.db, deps.providerRegistry)
  const invoiceService = new InvoiceService(deps.db, deps.providerRegistry, customerService)
  const planService = new BillingPlanService(deps.db, deps.providerRegistry)
  const subscriptionService = new SubscriptionService(
    deps.db,
    deps.providerRegistry,
    planService,
    customerService,
    invoiceService,
  )

  await subscriptionService.handleWebhookEvent(normalizedEvent)
}
