/**
 * Subscription Service — Gerencia assinaturas de billing.
 *
 * Orquestra: criação, atualização, cancelamento, sincronização via webhook.
 * Delega chamadas ao provider concreto via ProviderRegistry.
 */

import type { ProviderRegistry } from './provider-registry.js'
import type { NormalizedWebhookEvent, BillingContact, BillingProvider } from './provider.js'
import type { Db, DbTx } from '@comprova/db'
import * as t from '@comprova/db'
import { eq, and, desc, isNull, isNotNull, lt, or, sql } from '@comprova/db'
import { BillingPlanService } from './plan.service.js'
import { CustomerService } from './customer.service.js'
import { InvoiceService } from './invoice.service.js'
import { randomUUID } from 'node:crypto'

/**
 * Quanto tempo uma reserva de webhook pode ficar sem conclusão antes de ser
 * considerada órfã (processo caiu no meio). Entregas concorrentes dentro dessa
 * janela são tratadas como "em processamento".
 */
const WEBHOOK_CLAIM_STALE_MS = 5 * 60 * 1000

export interface ActivateBillingInput {
  readonly tenantId: string
  readonly planId: string
  readonly paymentMethodId?: string
  readonly trialDays?: number
  readonly billingContact: BillingContact
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
    const customerResult = await this.customerService.ensureCustomer(input.tenantId, input.billingContact, db)

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
        billingContactEmail: input.billingContact.email,
        billingCompanyName: input.billingContact.companyName,
        billingCnpj: input.billingContact.taxId,
        billingAddress: input.billingContact.address,
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
    const sub = await this.getSubscriptionOrThrow(subscriptionId, db)
    const provider = this.providerRegistry.get(sub.providerName)

    const planChange =
      input.planId && input.planId !== sub.planId ? await this.applyPlanChange(sub, input.planId, db) : {}
    const cancelChange =
      input.cancelAtPeriodEnd === undefined
        ? {}
        : await this.applyCancelAtPeriodEnd(
            sub.providerSubscriptionId ?? '',
            input.cancelAtPeriodEnd,
            provider,
          )
    const trialChange =
      input.trialEnd === undefined
        ? {}
        : await this.applyTrialEnd(sub.providerSubscriptionId ?? '', input.trialEnd, provider)
    const paymentMethodChange =
      input.paymentMethodId === undefined
        ? {}
        : await this.applyPaymentMethod(sub, input.paymentMethodId, provider)

    const updateData: Partial<t.NewTenantSubscription> = {
      ...planChange,
      ...cancelChange,
      ...trialChange,
      ...paymentMethodChange,
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
   * Aplica upgrade/downgrade de plano no provider (efeito) e devolve o patch local.
   */
  private async applyPlanChange(
    sub: t.TenantSubscription,
    planId: string,
    db: Db | DbTx,
  ): Promise<Partial<t.NewTenantSubscription>> {
    const newPlan = await this.planService.getPlan(planId, db)
    if (newPlan.providerName !== sub.providerName) {
      throw new Error('Cannot change provider via update. Create new subscription.')
    }

    const priceId = newPlan.providerPriceId ?? ''
    if (!priceId) {
      throw new Error('New plan has no providerPriceId')
    }

    await this.providerRegistry.get(sub.providerName).updateSubscription(sub.providerSubscriptionId ?? '', {
      priceId,
      prorationBehavior: 'create_prorations',
    })

    return { planId }
  }

  /**
   * Agenda/desfaz cancelamento no fim do período no provider e devolve o patch local.
   */
  private async applyCancelAtPeriodEnd(
    providerSubscriptionId: string,
    cancelAtPeriodEnd: boolean,
    provider: BillingProvider,
  ): Promise<Partial<t.NewTenantSubscription>> {
    if (providerSubscriptionId) {
      if (cancelAtPeriodEnd) {
        await provider.cancelSubscription(providerSubscriptionId, true)
      } else {
        await provider.updateSubscription(providerSubscriptionId, { cancelAtPeriodEnd: false })
      }
    }
    return { cancelAtPeriodEnd }
  }

  /**
   * Ajusta o fim de trial no provider e devolve o patch local.
   */
  private async applyTrialEnd(
    providerSubscriptionId: string,
    trialEnd: Date,
    provider: BillingProvider,
  ): Promise<Partial<t.NewTenantSubscription>> {
    if (providerSubscriptionId) {
      await provider.updateSubscription(providerSubscriptionId, { trialEnd })
    }
    return { trialEnd }
  }

  /**
   * Troca/remove o payment method no provider e devolve o patch local.
   */
  private async applyPaymentMethod(
    sub: t.TenantSubscription,
    paymentMethodId: string | null,
    provider: BillingProvider,
  ): Promise<Partial<t.NewTenantSubscription>> {
    const providerSubscriptionId = sub.providerSubscriptionId ?? ''
    const customerId = sub.providerCustomerId ?? ''

    if (paymentMethodId && providerSubscriptionId && customerId) {
      await provider.attachPaymentMethod(customerId, paymentMethodId)
      await provider.updateSubscription(providerSubscriptionId, {
        defaultPaymentMethodId: paymentMethodId,
      })
    } else if (!paymentMethodId && sub.paymentMethodId && providerSubscriptionId && customerId) {
      await provider.detachPaymentMethod(customerId, sub.paymentMethodId)
    }

    return { paymentMethodId }
  }

  /**
   * Cancela subscription imediatamente (não no fim do período).
   */
  async cancelSubscriptionNow(subscriptionId: string, tx?: DbTx): Promise<void> {
    const db = tx ?? this.db
    const sub = await this.getSubscriptionOrThrow(subscriptionId, db)

    const subId = sub.providerSubscriptionId ?? ''
    if (subId) {
      await this.providerRegistry.get(sub.providerName).cancelSubscription(subId, false)
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
    const sub = await this.getSubscriptionOrThrow(subscriptionId, db)

    const subId = sub.providerSubscriptionId ?? ''
    if (subId) {
      await this.providerRegistry.get(sub.providerName).pauseSubscription(subId)
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
    const sub = await this.getSubscriptionOrThrow(subscriptionId, db)

    const subId = sub.providerSubscriptionId ?? ''
    if (subId) {
      await this.providerRegistry.get(sub.providerName).resumeSubscription(subId)
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

    return this.findSubscriptionById(subscriptionId, db)
  }

  /**
   * Busca subscription por ID local.
   */
  private async findSubscriptionById(
    subscriptionId: string,
    db: Db | DbTx,
  ): Promise<t.TenantSubscription | null> {
    const [sub] = await db
      .select()
      .from(t.tenantSubscription)
      .where(eq(t.tenantSubscription.id, subscriptionId))
      .limit(1)

    return sub ?? null
  }

  /**
   * Busca subscription por ID ou lança erro se inexistente.
   */
  private async getSubscriptionOrThrow(subscriptionId: string, db: Db | DbTx): Promise<t.TenantSubscription> {
    const sub = await this.findSubscriptionById(subscriptionId, db)

    if (!sub) {
      throw new Error(`Subscription not found: ${subscriptionId}`)
    }
    return sub
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
   * Processa evento de webhook normalizado de forma persistente e idempotente.
   *
   * O evento é identificado por (provider, providerEventId). O processamento
   * dos efeitos de negócio e a marcação de conclusão acontecem na mesma
   * transação; falhas ficam registradas em `provider_webhook_event` para
   * diagnóstico e reprocessamento em uma entrega posterior.
   */
  async handleWebhookEvent(event: NormalizedWebhookEvent, tx?: DbTx): Promise<void> {
    // Reserve the event outside the business transaction. The unique
    // constraint on (provider_name, provider_event_id) makes this the
    // concurrency gate: only one delivery can claim the row.
    const claimed = await this.claimWebhookEvent(this.db, event)
    if (!claimed) return

    const process = async (db: Db | DbTx): Promise<void> => {
      await this.applyTenantContext(event, db)
      await this.dispatchWebhookEvent(event, db)
      await this.markWebhookProcessed(db, event)
    }

    try {
      if (tx) {
        await process(tx)
      } else {
        await this.db.transaction(process)
      }
    } catch (error) {
      // Persist the failure on the base connection so a rollback of the
      // business transaction does not erase the retry marker.
      await this.markWebhookFailed(this.db, event, error)
      throw error
    }
  }

  /**
   * Reserva o evento para processamento.
   *
   * Retorna `false` quando outra entrega já processou o evento ou está
   * processando agora. Eventos que falharam (ou cuja reserva ficou órfã por
   * muito tempo) podem ser reivindicados novamente.
   */
  private async claimWebhookEvent(db: Db | DbTx, event: NormalizedWebhookEvent): Promise<boolean> {
    const now = new Date()

    const [inserted] = await db
      .insert(t.providerWebhookEvent)
      .values({
        providerName: event.providerName,
        providerEventId: event.providerEventId,
        eventType: event.type,
        payload: event.payload ?? {},
        claimedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: t.providerWebhookEvent.id })

    if (inserted) {
      return true
    }

    const [existing] = await db
      .select()
      .from(t.providerWebhookEvent)
      .where(this.webhookEventWhere(event))
      .limit(1)

    if (!existing || existing.processedAt) {
      return false
    }

    // A previous delivery failed: atomically clear the error and claim it.
    if (existing.processingError) {
      const [retried] = await db
        .update(t.providerWebhookEvent)
        .set({
          processingError: null,
          claimedAt: now,
          retryCount: sql`${t.providerWebhookEvent.retryCount} + 1`,
        })
        .where(
          and(
            this.webhookEventWhere(event),
            isNull(t.providerWebhookEvent.processedAt),
            isNotNull(t.providerWebhookEvent.processingError),
          ),
        )
        .returning({ id: t.providerWebhookEvent.id })

      return retried !== undefined
    }

    // No error and not completed: assume another delivery is processing it.
    // Only reclaim if the claim is stale (e.g. the process crashed).
    const staleBefore = new Date(now.getTime() - WEBHOOK_CLAIM_STALE_MS)
    const [reclaimed] = await db
      .update(t.providerWebhookEvent)
      .set({
        claimedAt: now,
        retryCount: sql`${t.providerWebhookEvent.retryCount} + 1`,
      })
      .where(
        and(
          this.webhookEventWhere(event),
          isNull(t.providerWebhookEvent.processedAt),
          isNull(t.providerWebhookEvent.processingError),
          or(isNull(t.providerWebhookEvent.claimedAt), lt(t.providerWebhookEvent.claimedAt, staleBefore)),
        ),
      )
      .returning({ id: t.providerWebhookEvent.id })

    return reclaimed !== undefined
  }

  private webhookEventWhere(event: NormalizedWebhookEvent) {
    return and(
      eq(t.providerWebhookEvent.providerName, event.providerName),
      eq(t.providerWebhookEvent.providerEventId, event.providerEventId),
    )
  }

  private async markWebhookProcessed(db: Db | DbTx, event: NormalizedWebhookEvent): Promise<void> {
    await db
      .update(t.providerWebhookEvent)
      .set({ processedAt: new Date(), processingError: null, claimedAt: null })
      .where(and(this.webhookEventWhere(event), isNull(t.providerWebhookEvent.processedAt)))
  }

  private async markWebhookFailed(
    db: Db | DbTx,
    event: NormalizedWebhookEvent,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    await db
      .update(t.providerWebhookEvent)
      .set({ processingError: message.slice(0, 4_000), claimedAt: null })
      .where(and(this.webhookEventWhere(event), isNull(t.providerWebhookEvent.processedAt)))
  }

  /**
   * Resolve o tenant a partir do customer do provider (não de dados enviados
   * pelo cliente) e define o contexto usado pelas policies de RLS.
   */
  private async applyTenantContext(event: NormalizedWebhookEvent, db: Db | DbTx): Promise<void> {
    if (!event.providerCustomerId) {
      return
    }

    const tenant = await this.customerService.getTenantByProviderCustomerId(event.providerCustomerId, db)

    if (!tenant) {
      throw new Error(
        `Tenant not found for provider customer ${event.providerCustomerId} (${event.providerName})`,
      )
    }

    await db.execute(sql`SELECT set_config('app.tenant_id', ${tenant.tenantId}, true)`)
  }

  private async dispatchWebhookEvent(event: NormalizedWebhookEvent, db: Db | DbTx): Promise<void> {
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
          await this.handleTrialWillEnd(event.providerSubscriptionId, event.providerName, db)
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
          await this.handlePaymentMethodAttached(event.providerCustomerId, event.providerPaymentMethodId, db)
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

    // A pausa de cobrança só colapsa o status local quando o ciclo de vida
    // está ativo (Stripe só permite pausar subscription ativa). Demais status
    // (past_due, canceled...) preservam a semântica de ciclo de vida.
    const syncStatus =
      providerSub.status === 'active' && providerSub.pauseCollection !== null ? 'paused' : providerSub.status

    // Convenção tri-state nos campos opcionais: presente sincroniza, `null`
    // limpa o valor local, `undefined` preserva (provider não informou).
    const updateData: Partial<typeof t.tenantSubscription.$inferInsert> = {
      status: syncStatus,
      currentPeriodStart: providerSub.currentPeriodStart,
      currentPeriodEnd: providerSub.currentPeriodEnd,
      cancelAtPeriodEnd: providerSub.cancelAtPeriodEnd,
      metadata: {
        ...providerSub.metadata,
        lastSyncedAt: new Date().toISOString(),
      },
      ...(providerSub.trialStart !== undefined && { trialStart: providerSub.trialStart }),
      ...(providerSub.trialEnd !== undefined && { trialEnd: providerSub.trialEnd }),
      ...(providerSub.canceledAt !== undefined && { canceledAt: providerSub.canceledAt }),
      ...(providerSub.pausedAt !== undefined && { pausedAt: providerSub.pausedAt }),
      ...(providerSub.defaultPaymentMethodId !== undefined && {
        paymentMethodId: providerSub.defaultPaymentMethodId,
      }),
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
        pausedAt: null,
      })
      .where(eq(t.tenantSubscription.providerSubscriptionId, providerSubscriptionId))
  }

  /**
   * Trial terminando em breve: re-sincroniza a subscription para que o
   * `trial_end` local continue refletindo o provider.
   */
  private async handleTrialWillEnd(
    providerSubscriptionId: string,
    providerName: string,
    db: Db | DbTx,
  ): Promise<void> {
    await this.syncSubscription(providerSubscriptionId, providerName, db)
  }

  /**
   * Payment method anexado ao customer no provider: persiste localmente para
   * que o dashboard exiba o método padrão correto.
   */
  private async handlePaymentMethodAttached(
    providerCustomerId: string,
    providerPaymentMethodId: string | undefined,
    db: Db | DbTx,
  ): Promise<void> {
    if (!providerPaymentMethodId) {
      return
    }

    const tenant = await this.customerService.getTenantByProviderCustomerId(providerCustomerId, db)

    if (!tenant) {
      throw new Error(`Tenant not found for provider customer ${providerCustomerId}`)
    }

    await db
      .update(t.tenant)
      .set({ stripePaymentMethodId: providerPaymentMethodId })
      .where(eq(t.tenant.tenantId, tenant.tenantId))
  }
}
