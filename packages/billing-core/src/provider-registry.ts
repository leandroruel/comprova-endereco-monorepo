/**
 * Provider Registry — Dependency Injection para BillingProviders
 *
 * Permite registrar múltiplos providers (Stripe, Mercado Pago, Asaas)
 * e resolvê-los por nome ou por entidade (plan, subscription).
 */

import type { BillingProvider } from './provider.js'

// Type placeholders for plan and subscription (defined in db schemas)
export interface BillingPlan {
  readonly providerName: string
  readonly providerPriceId: string
  readonly providerProductId: string
  readonly features: Record<string, unknown>
  readonly id: string
}

export interface TenantSubscription {
  readonly providerName: string
  readonly providerSubscriptionId: string
  readonly providerCustomerId: string
  readonly id: string
}

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

  /**
   * Lista todos os providers registrados.
   */
  list(): ReadonlyArray<BillingProvider> {
    return Array.from(this.providers.values())
  }

  /**
   * Verifica se um provider está registrado.
   */
  has(name: string): boolean {
    return this.providers.has(name)
  }

  /**
   * Remove um provider (útil para testes).
   */
  unregister(name: string): boolean {
    return this.providers.delete(name)
  }

  /**
   * Limpa todos os providers (útil para testes).
   */
  clear(): void {
    this.providers.clear()
  }
}

// Instância singleton para uso global (bootstrap da aplicação)
export const providerRegistry = new ProviderRegistry()