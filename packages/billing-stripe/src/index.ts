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

let _stripeProvider: StripeProvider | null = null

/**
 * Inicializa e registra o StripeProvider.
 * Deve ser chamado uma vez no bootstrap da aplicação.
 */
export function initializeStripeProvider(config: {
  secretKey: string
  webhookSecret: string
  apiVersion?: string
  publishableKey?: string
}): StripeProvider {
  if (_stripeProvider) {
    return _stripeProvider
  }

  _stripeProvider = new StripeProvider(config)
  providerRegistry.register(_stripeProvider)
  return _stripeProvider
}

/**
 * Obtém instância já inicializada (lança erro se não inicializada).
 */
export function getStripeProvider(): StripeProvider {
  if (!_stripeProvider) {
    throw new Error('StripeProvider not initialized. Call initializeStripeProvider() first.')
  }
  return _stripeProvider
}
