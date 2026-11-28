/**
 * Customer Service — Gerencia customers no provider de billing.
 *
 * Abstrai a criação/atualização de customers e payment methods
 * no provider (Stripe, Mercado Pago, etc.).
 */

import type { ProviderRegistry } from './provider-registry.js'
import type { ProviderPaymentMethod, BillingContact } from './provider.js'
import type { Db, DbTx } from '@comprova/db'
import * as t from '@comprova/db'
import { eq, and } from '@comprova/db'
import { sql } from 'drizzle-orm'

export class CustomerService {
  constructor(
    private readonly db: Db,
    private readonly providerRegistry: ProviderRegistry,
  ) {}

  /**
   * Busca os dados de billing de um tenant (customer e provider).
   */
  private async findTenantBilling(
    tenantId: string,
    db: Db | DbTx,
  ): Promise<{ stripeCustomerId: string | null; providerName: string } | null> {
    const [tenantRecord] = await db
      .select({
        stripeCustomerId: sql<string | null>`${t.tenant.stripeCustomerId}`,
        providerName: sql<string | null>`${t.tenant.providerName}`,
      })
      .from(t.tenant)
      .where(eq(t.tenant.tenantId, tenantId))
      .limit(1)

    return tenantRecord
      ? {
          stripeCustomerId: tenantRecord.stripeCustomerId,
          providerName: tenantRecord.providerName ?? 'stripe',
        }
      : null
  }

  /**
   * Busca os dados de billing de um tenant que precisa ter customer.
   */
  private async requireTenantBilling(
    tenantId: string,
    db: Db | DbTx,
  ): Promise<{ stripeCustomerId: string; providerName: string }> {
    const tenantRecord = await this.findTenantBilling(tenantId, db)

    if (!tenantRecord?.stripeCustomerId) {
      throw new Error(`Tenant has no billing customer: ${tenantId}`)
    }

    return { stripeCustomerId: tenantRecord.stripeCustomerId, providerName: tenantRecord.providerName }
  }

  /**
   * Garante que existe um customer no provider para o tenant.
   * Se não existe, cria. Se existe, atualiza dados.
   */
  async ensureCustomer(
    tenantId: string,
    billingData: BillingContact,
    tx?: Db | DbTx,
  ): Promise<{ providerCustomerId: string; providerName: string }> {
    const db = tx ?? this.db

    const tenantRecord = await this.findTenantBilling(tenantId, db)

    if (!tenantRecord) {
      throw new Error(`Tenant not found: ${tenantId}`)
    }

    const provider = this.providerRegistry.get(tenantRecord.providerName)
    const customerMetadata = {
      comprova_tenant_id: tenantId,
      comprova_cnpj: billingData.taxId,
    }

    if (tenantRecord.stripeCustomerId) {
      // Atualiza customer existente
      await provider.updateCustomer(tenantRecord.stripeCustomerId, {
        email: billingData.email,
        name: billingData.companyName,
        companyName: billingData.companyName,
        taxId: billingData.taxId,
        address: billingData.address,
        metadata: customerMetadata,
      })
      return { providerCustomerId: tenantRecord.stripeCustomerId, providerName: tenantRecord.providerName }
    }

    // Cria novo customer no provider
    const customer = await provider.createCustomer({
      email: billingData.email,
      name: billingData.companyName,
      companyName: billingData.companyName,
      taxId: billingData.taxId,
      address: billingData.address,
      metadata: customerMetadata,
    })

    // Salva provider_customer_id no tenant
    await db
      .update(t.tenant)
      .set({
        stripeCustomerId: customer.id,
        providerName: tenantRecord.providerName,
      })
      .where(eq(t.tenant.tenantId, tenantId))

    return { providerCustomerId: customer.id, providerName: tenantRecord.providerName }
  }

  /**
   * Anexa um payment method ao customer e define como default.
   */
  async attachPaymentMethod(tenantId: string, paymentMethodId: string, tx?: Db | DbTx): Promise<void> {
    const db = tx ?? this.db

    const { stripeCustomerId, providerName } = await this.requireTenantBilling(tenantId, db)

    await this.providerRegistry.get(providerName).attachPaymentMethod(stripeCustomerId, paymentMethodId)

    // Atualiza payment_method_id no tenant
    await db
      .update(t.tenant)
      .set({ stripePaymentMethodId: paymentMethodId })
      .where(eq(t.tenant.tenantId, tenantId))
  }

  /**
   * Lista payment methods do customer.
   */
  async listPaymentMethods(tenantId: string, tx?: Db | DbTx): Promise<ReadonlyArray<ProviderPaymentMethod>> {
    const db = tx ?? this.db

    const tenantRecord = await this.findTenantBilling(tenantId, db)

    if (!tenantRecord?.stripeCustomerId) {
      return []
    }

    return this.providerRegistry
      .get(tenantRecord.providerName)
      .listPaymentMethods(tenantRecord.stripeCustomerId)
  }

  /**
   * Busca tenant pelo ID do customer no provider (ex.: Stripe customer ID).
   */
  async getTenantByProviderCustomerId(
    providerCustomerId: string,
    tx?: Db | DbTx,
  ): Promise<{ tenantId: string; providerName: string } | null> {
    const db = tx ?? this.db

    const [tenantRecord] = await db
      .select({
        tenantId: t.tenant.tenantId,
        providerName: t.tenant.providerName,
      })
      .from(t.tenant)
      .where(eq(t.tenant.stripeCustomerId, providerCustomerId))
      .limit(1)

    if (!tenantRecord) {
      return null
    }

    return {
      tenantId: tenantRecord.tenantId,
      providerName: tenantRecord.providerName ?? 'stripe',
    }
  }

  /**
   * Remove payment method do customer.
   */
  async detachPaymentMethod(tenantId: string, paymentMethodId: string, tx?: Db | DbTx): Promise<void> {
    const db = tx ?? this.db

    const { stripeCustomerId, providerName } = await this.requireTenantBilling(tenantId, db)

    await this.providerRegistry.get(providerName).detachPaymentMethod(stripeCustomerId, paymentMethodId)

    // Se era o default, limpa
    await db
      .update(t.tenant)
      .set({ stripePaymentMethodId: null })
      .where(
        and(eq(t.tenant.tenantId, tenantId), eq(sql`${t.tenant.stripePaymentMethodId}`, paymentMethodId)),
      )
  }
}
