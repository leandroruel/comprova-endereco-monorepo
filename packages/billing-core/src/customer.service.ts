/**
 * Customer Service — Gerencia customers no provider de billing.
 *
 * Abstrai a criação/atualização de customers e payment methods
 * no provider (Stripe, Mercado Pago, etc.).
 */

import type { ProviderRegistry } from './provider-registry.js'
import type { ProviderCustomer, CreateCustomerInput, UpdateCustomerInput, ProviderPaymentMethod, Address } from './provider.js'
import type { Db, DbTx } from '@comprova/db'
import * as t from '@comprova/db'
import { eq, and } from '@comprova/db'
import { sql } from 'drizzle-orm'

export interface CustomerBillingData {
  readonly email: string
  readonly companyName: string
  readonly taxId: string
  readonly address: Address
  readonly contactEmail?: string
}

export class CustomerService {
  constructor(
    private readonly db: Db,
    private readonly providerRegistry: ProviderRegistry,
  ) {}

  /**
   * Garante que existe um customer no provider para o tenant.
   * Se não existe, cria. Se existe, atualiza dados.
   */
  async ensureCustomer(
    tenantId: string,
    billingData: CustomerBillingData,
    tx?: DbTx,
  ): Promise<{ providerCustomerId: string; providerName: string }> {
    const db = tx ?? this.db

    // Busca tenant para ver se já tem customer
    const [tenantRecord] = await db
      .select({
        stripeCustomerId: sql<string | null>`${t.tenant.stripeCustomerId}`,
        providerName: sql<string | null>`${t.tenant.providerName}`,
      })
      .from(t.tenant)
      .where(eq(t.tenant.tenantId, tenantId))
      .limit(1)

    if (!tenantRecord) {
      throw new Error(`Tenant not found: ${tenantId}`)
    }

    const providerName = tenantRecord.providerName ?? 'stripe'
    const provider = this.providerRegistry.get(providerName)

    if (tenantRecord.stripeCustomerId) {
      // Atualiza customer existente
      await provider.updateCustomer(tenantRecord.stripeCustomerId, {
        email: billingData.email,
        name: billingData.companyName,
        companyName: billingData.companyName,
        taxId: billingData.taxId,
        address: billingData.address,
        metadata: {
          comprova_tenant_id: tenantId,
          comprova_cnpj: billingData.taxId,
        },
      })
      return { providerCustomerId: tenantRecord.stripeCustomerId, providerName }
    }

    // Cria novo customer no provider
    const customer = await provider.createCustomer({
      email: billingData.email,
      name: billingData.companyName,
      companyName: billingData.companyName,
      taxId: billingData.taxId,
      address: billingData.address,
      metadata: {
        comprova_tenant_id: tenantId,
        comprova_cnpj: billingData.taxId,
      },
    })

    // Salva provider_customer_id no tenant
    await db
      .update(t.tenant)
      .set({
        stripeCustomerId: customer.id,
        providerName,
      })
      .where(eq(t.tenant.tenantId, tenantId))

    return { providerCustomerId: customer.id, providerName }
  }

  /**
   * Anexa um payment method ao customer e define como default.
   */
  async attachPaymentMethod(
    tenantId: string,
    paymentMethodId: string,
    tx?: DbTx,
  ): Promise<void> {
    const db = tx ?? this.db

    const [tenantRecord] = await db
      .select({
        stripeCustomerId: sql<string | null>`${t.tenant.stripeCustomerId}`,
        providerName: sql<string | null>`${t.tenant.providerName}`,
      })
      .from(t.tenant)
      .where(eq(t.tenant.tenantId, tenantId))
      .limit(1)

    if (!tenantRecord || !tenantRecord.stripeCustomerId) {
      throw new Error(`Tenant has no billing customer: ${tenantId}`)
    }

    const provider = this.providerRegistry.get(tenantRecord.providerName ?? 'stripe')
    await provider.attachPaymentMethod(tenantRecord.stripeCustomerId, paymentMethodId)

    // Atualiza payment_method_id no tenant
    await db
      .update(t.tenant)
      .set({ stripePaymentMethodId: paymentMethodId })
      .where(eq(t.tenant.tenantId, tenantId))
  }

  /**
   * Lista payment methods do customer.
   */
  async listPaymentMethods(tenantId: string, tx?: DbTx): Promise<ReadonlyArray<ProviderPaymentMethod>> {
    const db = tx ?? this.db

    const [tenantRecord] = await db
      .select({
        stripeCustomerId: sql<string | null>`${t.tenant.stripeCustomerId}`,
        providerName: sql<string | null>`${t.tenant.providerName}`,
      })
      .from(t.tenant)
      .where(eq(t.tenant.tenantId, tenantId))
      .limit(1)

    if (!tenantRecord || !tenantRecord.stripeCustomerId) {
      return []
    }

    const provider = this.providerRegistry.get(tenantRecord.providerName ?? 'stripe')
    return provider.listPaymentMethods(tenantRecord.stripeCustomerId)
  }

  /**
   * Remove payment method do customer.
   */
  async detachPaymentMethod(tenantId: string, paymentMethodId: string, tx?: DbTx): Promise<void> {
    const db = tx ?? this.db

    const [tenantRecord] = await db
      .select({
        stripeCustomerId: sql<string | null>`${t.tenant.stripeCustomerId}`,
        providerName: sql<string | null>`${t.tenant.providerName}`,
      })
      .from(t.tenant)
      .where(eq(t.tenant.tenantId, tenantId))
      .limit(1)

    if (!tenantRecord || !tenantRecord.stripeCustomerId) {
      throw new Error(`Tenant has no billing customer: ${tenantId}`)
    }

    const provider = this.providerRegistry.get(tenantRecord.providerName ?? 'stripe')
    await provider.detachPaymentMethod(tenantRecord.stripeCustomerId, paymentMethodId)

    // Se era o default, limpa
    await db
      .update(t.tenant)
      .set({ stripePaymentMethodId: null })
      .where(and(eq(t.tenant.tenantId, tenantId), eq(sql`${t.tenant.stripePaymentMethodId}`, paymentMethodId)))
  }
}