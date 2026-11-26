/**
 * @comprova/billing-core — Core Billing Abstraction Layer
 *
 * Exporta interfaces, services e registry para o sistema de billing
 * com suporte a múltiplos providers (Stripe, Mercado Pago, Asaas, etc.).
 */

// Provider Interface & Registry
export * from './provider.js'
export { ProviderRegistry, providerRegistry } from './provider-registry.js'

// Domain Services
export { BillingPlanService } from './plan.service.js'
export { CustomerService } from './customer.service.js'
export { SubscriptionService } from './subscription.service.js'
export { InvoiceService } from './invoice.service.js'

// Types re-exportados para conveniência
export type { PlanFeatures, PlanPricing } from './provider.js'
export type { CreatePlanInput, UpdatePlanInput } from './plan.service.js'
export type { CustomerBillingData } from './customer.service.js'
export type { ActivateBillingInput, SubscriptionWithPlan } from './subscription.service.js'
export type { InvoiceWithDetails } from './invoice.service.js'
