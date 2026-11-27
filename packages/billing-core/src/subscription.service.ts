/**
 * Subscription Service — Gerencia assinaturas de billing.
 *
 * Orquestra: criação, atualização, cancelamento, sincronização via webhook.
 * Delega chamadas ao provider concreto via ProviderRegistry.
 */

import type { ProviderRegistry } from './provider-registry.js'
import type { NormalizedWebhookEvent } from './provider.js'
import type { Db, DbTx } from '@comprova/db'
import * as t from '@comprova/db'
import { eq, and, desc } from '@comprova/db'
import { BillingPlanService } from './plan.service.js'
import { CustomerService } from './customer.service.js'
import { InvoiceService } from './invoice.service.js'
import { randomUUID } from 'node:crypto'

export interface ActivateBillingInput {
  readonly tenantId: string
  readonly planId: string
  readonly paymentMethodId?: string
  readonly trialDays?: number
  readonly billingContactEmail: string
  readonly billingCompanyName: string
  readonly billingCnpj: string
  readonly billingAddress: {
    readonly street: string
    readonly city: string
    readonly state: string
    readonly zip: string
    readonly country?: string
  }
}

export interface SubscriptionWithPlan {
  readonly subscription: t.TenantSubscription
  readonly plan: t.BillingPlan
}

export class SubscriptionService {
  constructor(
    private readonly db: Db,
    private readonly providerRegistry: ProviderRegistry,
    private readonly planService: BillingPlanService,
    private readonly customerService: CustomerService,
    private readonly invoiceService: InvoiceService,
  ) {}

  /**
   * Ativa billing para um tenant (chamado pelo admin).
   * Cria customer no provider, anexa payment method se fornecido,
   * e cria a subscription.
   */
  async activateBilling(input: ActivateBillingInput, tx?: DbTx): Promise<t.TenantSubscription> {
    const db = tx ?? this.db

    // 1. Valida plano
    const plan = await this.planService.getPlan(input.planId, db)
    if (!plan.isActive) {
      throw new Error(`Plan is not active: ${input.planId}`)
    }

    const provider = this.providerRegistry.get(plan.providerName)
    const priceId = plan.providerPriceId ?? ''
    if (!priceId) {
      throw new Error('Plan has no providerPriceId')
    }

    // 2. Garante customer no provider
    const customerResult = await this.customerService.ensureCustomer(
      input.tenantId,
      {
        email: input.billingContactEmail,
        companyName: input.billingCompanyName,
        taxId: input.billingCnpj,
        address: input.billingAddress,
        contactEmail: input.billingContactEmail,
      },
      db,
    )

    // 3. Anexa payment method se fornecido
    if (input.paymentMethodId) {
      await provider.attachPaymentMethod(customerResult.providerCustomerId, input.paymentMethodId)
    }

    // 4. Cria subscription no provider - sempre allow_incomplete para permitir 3DS
    const subscription = await provider.createSubscription({
      customerId: customerResult.providerCustomerId,
      priceId,
      trialDays: input.trialDays ?? plan.trialPeriodDays ?? undefined,
      defaultPaymentMethodId: input.paymentMethodId,
      paymentBehavior: 'allow_incomplete',
      metadata: {
        comprova_tenant_id: input.tenantId,
        comprova_plan_id: plan.id,
      },
      idempotencyKey: `sub-${input.tenantId}-${plan.id}`,
    })

    const now = new Date()
    const periodEnd = subscription.currentPeriodEnd ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

    // 5. Salva subscription local
    const [created] = await db
      .insert(t.tenantSubscription)
      .values({
        id: randomUUID(),
        tenantId: input.tenantId,
        planId: input.planId,
        providerName: plan.providerName,
        providerCustomerId: customerResult.providerCustomerId,
        providerSubscriptionId: subscription.id,
        status: subscription.status,
        currentPeriodStart: subscription.currentPeriodStart ?? now,
        currentPeriodEnd: periodEnd,
        trialStart: subscription.trialStart,
        trialEnd: subscription.trialEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        canceledAt: subscription.canceledAt,
        pausedAt: subscription.pausedAt,
        paymentMethodId: subscription.defaultPaymentMethodId ?? input.paymentMethodId,
        billingContactEmail: input.billingContactEmail,
        billingCompanyName: input.billingCompanyName,
        billingCnpj: input.billingCnpj,
        billingAddress: input.billingAddress,
        billingCycleAnchor: subscription.currentPeriodStart ?? now,
        periodStart: subscription.currentPeriodStart ?? now,
        periodEnd,
        metadata: {
          comprova_tenant_id: input.tenantId,
          comprova_plan_id: plan.id,
        },
      })
      .returning()

    if (!created) {
      throw new Error('Failed to create tenant subscription')
    }

    // 6. Atualiza tenant com provider info
    await db
      .update(t.tenant)
      .set({
        providerName: plan.providerName,
        stripeCustomerId: customerResult.providerCustomerId,
        stripePaymentMethodId: input.paymentMethodId,
      })
      .where(eq(t.tenant.tenantId, input.tenantId))

    return created
  }

  /**
   * Atualiza subscription (upgrade/downgrade, cancelamento, etc.)
   */
  async updateSubscription(
    subscriptionId: string,
    input: {
      readonly planId?: string
      readonly cancelAtPeriodEnd?: boolean
      readonly trialEnd?: Date
      readonly paymentMethodId?: string
    },
    tx?: DbTx,
  ): Promise<t.TenantSubscription> {
    const db = tx ?? this.db

    const [sub] = await db
      .select()
      .from(t.tenantSubscription)
      .where(eq(t.tenantSubscription.id, subscriptionId))
      .limit(1)

    if (!sub) {
      throw new Error(`Subscription not found: ${subscriptionId}`)
    }

    const provider = this.providerRegistry.get(sub.providerName)
    const updateData: Partial<t.NewTenantSubscription> = {}

    // Upgrade/downgrade de plano
    if (input.planId && input.planId !== sub.planId) {
      const newPlan = await this.planService.getPlan(input.planId, db)
      if (newPlan.providerName !== sub.providerName) {
        throw new Error('Cannot change provider via update. Create new subscription.')
      }

      const priceId = newPlan.providerPriceId ?? ''
      if (!priceId) {
        throw new Error('New plan has no providerPriceId')
      }

      await provider.updateSubscription(sub.providerSubscriptionId ?? '', {
        priceId,
        prorationBehavior: 'create_prorations',
      })

      updateData.planId = input.planId
    }

    // Cancelamento
    if (input.cancelAtPeriodEnd !== undefined) {
      if (input.cancelAtPeriodEnd) {
        const subId = sub.providerSubscriptionId ?? ''
        if (subId) {
          await provider.cancelSubscription(subId, true)
        }
      } else {
        const subId = sub.providerSubscriptionId ?? ''
        if (subId) {
          await provider.updateSubscription(subId, {
            cancelAtPeriodEnd: false,
          })
        }
      }
      updateData.cancelAtPeriodEnd = input.cancelAtPeriodEnd
    }

    // Trial end
    if (input.trialEnd !== undefined) {
      const subId = sub.providerSubscriptionId ?? ''
      if (subId) {
        await provider.updateSubscription(subId, {
          trialEnd: input.trialEnd,
        })
      }
      updateData.trialEnd = input.trialEnd
    }

    // Payment method
    if (input.paymentMethodId !== undefined) {
      const subId = sub.providerSubscriptionId ?? ''
      const customerId = sub.providerCustomerId ?? ''
      if (input.paymentMethodId) {
        if (subId && customerId) {
          await provider.attachPaymentMethod(customerId, input.paymentMethodId)
          await provider.updateSubscription(subId, {
            defaultPaymentMethodId: input.paymentMethodId,
          })
        }
      } else if (sub.paymentMethodId && subId && customerId) {
        await provider.detachPaymentMethod(customerId, sub.paymentMethodId)
      }
      updateData.paymentMethodId = input.paymentMethodId
    }

    const [updated] = await db
      .update(t.tenantSubscription)
      .set(updateData)
      .where(eq(t.tenantSubscription.id, subscriptionId))
      .returning()

    if (!updated) {
      throw new Error('Failed to update subscription')
    }

    return updated
  }

  /**
   * Cancela subscription imediatamente (não no fim do período).
   */
  async cancelSubscriptionNow(subscriptionId: string, tx?: DbTx): Promise<void> {
    const db = tx ?? this.db

    const [sub] = await db
      .select()
      .from(t.tenantSubscription)
      .where(eq(t.tenantSubscription.id, subscriptionId))
      .limit(1)

    if (!sub) {
      throw new Error(`Subscription not found: ${subscriptionId}`)
    }

    const provider = this.providerRegistry.get(sub.providerName)
    const subId = sub.providerSubscriptionId ?? ''
    if (subId) {
      await provider.cancelSubscription(subId, false)
    }

    await db
      .update(t.tenantSubscription)
      .set({
        status: 'canceled',
        canceledAt: new Date(),
        cancelAtPeriodEnd: false,
      })
      .where(eq(t.tenantSubscription.id, subscriptionId))
  }

  /**
   * Pausa subscription.
   */
  async pauseSubscription(subscriptionId: string, tx?: DbTx): Promise<void> {
    const db = tx ?? this.db

    const [sub] = await db
      .select()
      .from(t.tenantSubscription)
      .where(eq(t.tenantSubscription.id, subscriptionId))
      .limit(1)

    if (!sub) {
      throw new Error(`Subscription not found: ${subscriptionId}`)
    }

    const provider = this.providerRegistry.get(sub.providerName)
    const subId = sub.providerSubscriptionId ?? ''
    if (subId) {
      await provider.pauseSubscription(subId)
    }

    await db
      .update(t.tenantSubscription)
      .set({
        status: 'paused',
        pausedAt: new Date(),
      })
      .where(eq(t.tenantSubscription.id, subscriptionId))
  }

  /**
   * Retoma subscription pausada.
   */
  async resumeSubscription(subscriptionId: string, tx?: DbTx): Promise<void> {
    const db = tx ?? this.db

    const [sub] = await db
      .select()
      .from(t.tenantSubscription)
      .where(eq(t.tenantSubscription.id, subscriptionId))
      .limit(1)

    if (!sub) {
      throw new Error(`Subscription not found: ${subscriptionId}`)
    }

    const provider = this.providerRegistry.get(sub.providerName)
    const subId = sub.providerSubscriptionId ?? ''
    if (subId) {
      await provider.resumeSubscription(subId)
    }

    await db
      .update(t.tenantSubscription)
      .set({
        status: 'active',
        pausedAt: null,
      })
      .where(eq(t.tenantSubscription.id, subscriptionId))
  }

  /**
   * Busca subscription ativa do tenant.
   */
  async getActiveSubscription(tenantId: string, tx?: DbTx): Promise<SubscriptionWithPlan | null> {
    const db = tx ?? this.db

    const [sub] = await db
      .select({
        subscription: t.tenantSubscription,
        plan: t.billingPlan,
      })
      .from(t.tenantSubscription)
      .innerJoin(t.billingPlan, eq(t.tenantSubscription.planId, t.billingPlan.id))
      .where(and(eq(t.tenantSubscription.tenantId, tenantId), eq(t.tenantSubscription.status, 'active')))
      .orderBy(desc(t.tenantSubscription.createdAt))
      .limit(1)

    return sub ?? null
  }

  /**
   * Busca subscription por ID.
   */
  async getSubscription(subscriptionId: string, tx?: DbTx): Promise<t.TenantSubscription | null> {
    const db = tx ?? this.db

    const [sub] = await db
      .select()
      .from(t.tenantSubscription)
      .where(eq(t.tenantSubscription.id, subscriptionId))
      .limit(1)

    return sub ?? null
  }

  /**
   * Busca subscription por provider_subscription_id.
   */
  async getSubscriptionByProviderId(
    providerSubscriptionId: string,
    tx?: DbTx,
  ): Promise<t.TenantSubscription | null> {
    const db = tx ?? this.db

    const [sub] = await db
      .select()
      .from(t.tenantSubscription)
      .where(eq(t.tenantSubscription.providerSubscriptionId, providerSubscriptionId))
      .limit(1)

    return sub ?? null
  }

  /**
   * Lista subscriptions do tenant.
   */
  async listSubscriptions(tenantId: string, tx?: DbTx): Promise<ReadonlyArray<t.TenantSubscription>> {
    const db = tx ?? this.db

    return db
      .select()
      .from(t.tenantSubscription)
      .where(eq(t.tenantSubscription.tenantId, tenantId))
      .orderBy(desc(t.tenantSubscription.createdAt))
  }

  /**
   * Processa evento de webhook normalizado.
   * Delega para handlers específicos baseados no tipo.
   */
  async handleWebhookEvent(event: NormalizedWebhookEvent, tx?: DbTx): Promise<void> {
    const db = tx ?? this.db

    switch (event.type) {
      case 'subscription.created':
      case 'subscription.updated':
        if (event.providerSubscriptionId && event.providerName) {
          await this.syncSubscription(event.providerSubscriptionId, event.providerName, db)
        }
        break

      case 'subscription.canceled':
        if (event.providerSubscriptionId) {
          await this.handleSubscriptionCanceled(event.providerSubscriptionId, db)
        }
        break

      case 'subscription.trial_will_end':
        if (event.providerSubscriptionId) {
          await this.handleTrialWillEnd(event.providerSubscriptionId, db)
        }
        break

      case 'invoice.created':
      case 'invoice.finalized':
        if (event.providerInvoiceId && event.providerName) {
          await this.invoiceService.syncInvoice(event.providerInvoiceId, event.providerName, db)
        }
        break

      case 'invoice.paid':
        if (event.providerInvoiceId && event.providerName) {
          await this.invoiceService.syncInvoice(event.providerInvoiceId, event.providerName, db)
        }
        break

      case 'invoice.payment_failed':
        if (event.providerInvoiceId && event.providerName) {
          await this.invoiceService.syncInvoice(event.providerInvoiceId, event.providerName, db)
        }
        break

      case 'payment_intent.succeeded':
        if (event.providerPaymentId && event.providerName) {
          await this.invoiceService.syncPayment(event.providerPaymentId, event.providerName, db)
        }
        break

      case 'payment_intent.payment_failed':
        if (event.providerPaymentId && event.providerName) {
          await this.invoiceService.syncPayment(event.providerPaymentId, event.providerName, db)
        }
        break

      case 'payment_method.attached':
        if (event.providerCustomerId) {
          await this.handlePaymentMethodAttached(event.providerCustomerId, db)
        }
        break
    }
  }

  // ---------------------------------------------------------------------------
  // Handlers Privados
  // ---------------------------------------------------------------------------

  private async syncSubscription(
    providerSubscriptionId: string,
    providerName: string,
    db: Db | DbTx,
  ): Promise<void> {
    const provider = this.providerRegistry.get(providerName)
    const providerSub = await provider.getSubscription(providerSubscriptionId)

    if (!providerSub) {
      // Subscription não existe mais no provider - marca como cancelada
      await db
        .update(t.tenantSubscription)
        .set({ status: 'canceled', canceledAt: new Date() })
        .where(eq(t.tenantSubscription.providerSubscriptionId, providerSubscriptionId))
      return
    }

    // Build update data, only including defined fields to avoid overwriting with null
    const updateData: Partial<typeof t.tenantSubscription.$inferInsert> = {
      status: providerSub.status,
      currentPeriodStart: providerSub.currentPeriodStart,
      currentPeriodEnd: providerSub.currentPeriodEnd,
      cancelAtPeriodEnd: providerSub.cancelAtPeriodEnd,
      metadata: {
        ...providerSub.metadata,
        lastSyncedAt: new Date().toISOString(),
      },
    }

    // Only include optional fields if they are defined
    if (providerSub.trialStart !== undefined) {
      updateData.trialStart = providerSub.trialStart
    }
    if (providerSub.trialEnd !== undefined) {
      updateData.trialEnd = providerSub.trialEnd
    }
    if (providerSub.canceledAt !== undefined) {
      updateData.canceledAt = providerSub.canceledAt
    }
    if (providerSub.cancelAtPeriodEnd !== undefined) {
      updateData.cancelAtPeriodEnd = providerSub.cancelAtPeriodEnd
    }
    if (providerSub.pausedAt !== undefined) {
      updateData.pausedAt = providerSub.pausedAt
    }
    if (providerSub.defaultPaymentMethodId !== undefined) {
      updateData.paymentMethodId = providerSub.defaultPaymentMethodId
    }

    await db
      .update(t.tenantSubscription)
      .set(updateData)
      .where(eq(t.tenantSubscription.providerSubscriptionId, providerSubscriptionId))
  }

  private async handleSubscriptionCanceled(providerSubscriptionId: string, db: Db | DbTx): Promise<void> {
    await db
      .update(t.tenantSubscription)
      .set({
        status: 'canceled',
        canceledAt: new Date(),
        cancelAtPeriodEnd: false,
      })
      .where(eq(t.tenantSubscription.providerSubscriptionId, providerSubscriptionId))
  }

  private async handleTrialWillEnd(providerSubscriptionId: string, _db: Db | DbTx): Promise<void> {
    console.log(`Trial will end for subscription: ${providerSubscriptionId}`)
  }

  private async handlePaymentMethodAttached(providerCustomerId: string, _db: Db | DbTx): Promise<void> {
    console.log(`Payment method attached for customer: ${providerCustomerId}`)
  }
}
