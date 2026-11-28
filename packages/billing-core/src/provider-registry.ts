/**
 * Provider Registry — Dependency Injection para BillingProviders
 *
 * Permite registrar múltiplos providers (Stripe, Mercado Pago, Asaas)
 * e resolvê-los por nome.
 */

import type { BillingProvider } from './provider.js'
import type { BillingPlan, TenantSubscription } from '@comprova/db'

export class ProviderRegistry {
  private readonly providers = new Map<string, BillingProvider>()

  /**
   * Registra um provider. Lança erro se já existir provider com mesmo nome.
   */
  register(provider: BillingProvider): void {
    if (this.providers.has(provider.name)) {
      throw new Error(`Provider ${provider.name} already registered`)
    }
    this.providers.set(provider.name, provider)
  }

  /**
   * Obtém provider por nome. Lança erro se não encontrado.
   */
  get(name: string): BillingProvider {
    const provider = this.providers.get(name)
    if (!provider) {
      const available = Array.from(this.providers.keys()).join(', ')
      throw new Error(`Provider ${name} not registered. Available: ${available}`)
    }
    return provider
  }

  /**
   * Verifica se um provider está registrado.
   */
  has(name: string): boolean {
    return this.providers.has(name)
  }

  /**
   * Obtém provider a partir de um billing_plan.
   */
  getByPlan(plan: BillingPlan): BillingProvider {
    return this.get(plan.providerName)
  }

  /**
   * Obtém provider a partir de uma tenant_subscription.
   */
  getBySubscription(subscription: TenantSubscription): BillingProvider {
    return this.get(subscription.providerName)
  }
}

// Instância singleton para uso global (bootstrap da aplicação)
export const providerRegistry = new ProviderRegistry()
