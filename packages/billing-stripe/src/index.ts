/**
 * @comprova/billing-stripe — Stripe Provider Implementation
 *
 * Implementa BillingProvider usando o SDK oficial do Stripe.
 * Registra-se automaticamente no ProviderRegistry global.
 */

export { StripeProvider } from './stripe-provider.js'
export type { StripeProviderConfig } from './stripe-provider.js'

// Auto-registration helper
import { providerRegistry } from '@comprova/billing-core'
import { StripeProvider } from './stripe-provider.js'

const STRIPE_PROVIDER_NAME = 'stripe'

/**
 * Inicializa e registra o StripeProvider (idempotente).
 * Deve ser chamado no bootstrap da aplicação.
 */
export function initializeStripeProvider(config: {
  secretKey: string
  webhookSecret: string
}): StripeProvider {
  if (providerRegistry.has(STRIPE_PROVIDER_NAME)) {
    return getStripeProvider()
  }

  const provider = new StripeProvider(config)
  providerRegistry.register(provider)
  return provider
}

/**
 * Obtém instância já registrada (lança erro se não inicializada).
 */
export function getStripeProvider(): StripeProvider {
  const provider = providerRegistry.get(STRIPE_PROVIDER_NAME)

  if (!(provider instanceof StripeProvider)) {
    throw new Error(`Provider registered as "${STRIPE_PROVIDER_NAME}" is not a StripeProvider`)
  }
  return provider
}
