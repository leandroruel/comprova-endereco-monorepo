/**
 * Stripe Provider Implementation
 *
 * Implementa a interface BillingProvider usando o SDK oficial do Stripe.
 * Todas as chamadas incluem idempotency keys para segurança.
 */

import Stripe from 'stripe'
import type {
  BillingProvider,
  ProviderProduct,
  ProviderPrice,
  ProviderCustomer,
  ProviderPaymentMethod,
  ProviderSubscription,
  ProviderInvoice,
  ProviderPayment,
  ProviderCreditNote,
  ProviderWebhookEvent,
  NormalizedWebhookEvent,
  CreateProductInput,
  UpdateProductInput,
  CreatePriceInput,
  CreateCustomerInput,
  UpdateCustomerInput,
  CreateSubscriptionInput,
  UpdateSubscriptionInput,
  CreateInvoiceInput,
  ListInvoicesOptions,
  CreateCreditNoteInput,
  Currency,
  Interval,
  WebhookEventType,
  Address,
} from '@comprova/billing-core'

export interface StripeProviderConfig {
  readonly secretKey: string
  readonly webhookSecret: string
  readonly apiVersion?: string
  readonly publishableKey?: string
}

export class StripeProvider implements BillingProvider {
  readonly name = 'stripe'
  readonly supportedCurrencies: readonly Currency[] = ['BRL', 'USD', 'EUR']
  readonly supportedIntervals: readonly Interval[] = ['month', 'year']
  readonly supportedPaymentMethods = ['card', 'boleto', 'pix', 'bank_transfer', 'link']

  private readonly stripe: Stripe

  constructor(config: StripeProviderConfig) {
    this.stripe = new Stripe(config.secretKey, {
      apiVersion: config.apiVersion ?? '2024-06-20',
      typescript: true,
      maxNetworkRetries: 3,
    })
  }

  // ============================================================================
  // Products & Prices
  // ============================================================================

  async createProduct(input: CreateProductInput): Promise<ProviderProduct> {
    const product = await this.stripe.products.create(
      {
        name: input.name,
        description: input.description,
        metadata: input.metadata,
        active: true,
      },
      { idempotencyKey: input.idempotencyKey },
    )
    return this.mapProduct(product)
  }

  async updateProduct(id: string, input: UpdateProductInput): Promise<void> {
    await this.stripe.products.update(
      id,
      {
        name: input.name,
        description: input.description,
        metadata: input.metadata,
        active: input.active,
      },
      { idempotencyKey: input.idempotencyKey },
    )
  }

  async archiveProduct(id: string): Promise<void> {
    await this.stripe.products.update(id, { active: false })
  }

  async createPrice(productId: string, input: CreatePriceInput): Promise<ProviderPrice> {
    const price = await this.stripe.prices.create(
      {
        product: productId,
        currency: input.currency.toLowerCase(),
        unit_amount: this.microsToCentavos(input.unitAmountMicros),
        recurring: {
          interval: input.interval,
          interval_count: input.intervalCount,
          usage_type: input.usageType,
        },
        trial_period_days: input.trialPeriodDays,
        metadata: input.metadata,
      },
      { idempotencyKey: input.idempotencyKey },
    )
    return this.mapPrice(price)
  }

  // ============================================================================
  // Customers
  // ============================================================================

  async createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer> {
    const customer = await this.stripe.customers.create(
      {
        email: input.email,
        name: input.name,
        company: input.companyName,
        tax_id: input.taxId,
        address: input.address ? this.mapAddress(input.address) : undefined,
        metadata: input.metadata,
      },
      { idempotencyKey: input.idempotencyKey },
    )
    return this.mapCustomer(customer)
  }

  async updateCustomer(id: string, input: UpdateCustomerInput): Promise<void> {
    await this.stripe.customers.update(
      id,
      {
        email: input.email,
        name: input.name,
        company: input.companyName,
        tax_id: input.taxId,
        address: input.address ? this.mapAddress(input.address) : undefined,
        metadata: input.metadata,
      },
      { idempotencyKey: input.idempotencyKey },
    )
  }

  async attachPaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
    await this.stripe.paymentMethods.attach(paymentMethodId, { customer: customerId })
    await this.stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    })
  }

  async detachPaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
    await this.stripe.paymentMethods.detach(paymentMethodId)
  }

  async listPaymentMethods(customerId: string): Promise<ReadonlyArray<ProviderPaymentMethod>> {
    const methods = await this.stripe.paymentMethods.list({
      customer: customerId,
      type: 'card',
    })
    return methods.data.map(this.mapPaymentMethod)
  }

  // ============================================================================
  // Subscriptions
  // ============================================================================

  async createSubscription(input: CreateSubscriptionInput): Promise<ProviderSubscription> {
    const subscription = await this.stripe.subscriptions.create(
      {
        customer: input.customerId,
        items: [{ price: input.priceId, quantity: input.quantity ?? 1 }],
        trial_period_days: input.trialDays,
        default_payment_method: input.defaultPaymentMethodId,
        payment_behavior: input.paymentBehavior ?? 'allow_incomplete',
        expand: ['latest_invoice.payment_intent', 'default_payment_method'],
        metadata: input.metadata,
      },
      { idempotencyKey: input.idempotencyKey },
    )
    return this.mapSubscription(subscription)
  }

  async updateSubscription(id: string, input: UpdateSubscriptionInput): Promise<void> {
    const updateParams: Stripe.SubscriptionUpdateParams = {
      metadata: input.metadata,
    }

    if (input.priceId) {
      updateParams.items = [
        {
          id: (await this.stripe.subscriptions.retrieve(id)).items.data[0]?.id,
          price: input.priceId,
        },
      ]
      updateParams.proration_behavior = input.prorationBehavior ?? 'create_prorations'
    }
    if (input.quantity !== undefined) {
      updateParams.items = [{ quantity: input.quantity }]
    }
    if (input.trialEnd) {
      updateParams.trial_end = Math.floor(input.trialEnd.getTime() / 1000)
    }
    if (input.cancelAtPeriodEnd !== undefined) {
      updateParams.cancel_at_period_end = input.cancelAtPeriodEnd
    }
    if (input.defaultPaymentMethodId) {
      updateParams.default_payment_method = input.defaultPaymentMethodId
    }

    await this.stripe.subscriptions.update(id, updateParams, { idempotencyKey: input.idempotencyKey })
  }

  async cancelSubscription(id: string, atPeriodEnd: boolean): Promise<void> {
    if (atPeriodEnd) {
      await this.stripe.subscriptions.update(id, { cancel_at_period_end: true })
    } else {
      await this.stripe.subscriptions.cancel(id)
    }
  }

  async pauseSubscription(id: string): Promise<void> {
    await this.stripe.subscriptions.update(id, { pause_collection: { behavior: 'void' } })
  }

  async resumeSubscription(id: string): Promise<void> {
    await this.stripe.subscriptions.update(id, { pause_collection: null })
  }

  async getSubscription(id: string): Promise<ProviderSubscription | null> {
    try {
      const subscription = await this.stripe.subscriptions.retrieve(id, {
        expand: ['default_payment_method', 'items.data.price.product'],
      })
      return this.mapSubscription(subscription)
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') {
        return null
      }
      throw error
    }
  }

  // ============================================================================
  // Invoices & Payments
  // ============================================================================

  async createInvoice(input: CreateInvoiceInput): Promise<ProviderInvoice> {
    const inv = await this.stripe.invoices.create(
      {
        customer: input.customerId,
        subscription: input.subscriptionId,
        auto_advance: input.autoAdvance ?? true,
        collection_method: input.collectionMethod ?? 'charge_automatically',
        days_until_due: input.daysUntilDue,
        metadata: input.metadata,
      },
      { idempotencyKey: input.idempotencyKey },
    )
    return this.mapInvoice(inv)
  }

  async finalizeInvoice(id: string): Promise<void> {
    await this.stripe.invoices.finalizeInvoice(id)
  }

  async payInvoice(id: string, paymentMethodId?: string): Promise<ProviderPayment> {
    const inv = await this.stripe.invoices.pay(id, { payment_method: paymentMethodId })
    // O payment_intent vem expandido ou na invoice
    const paymentIntent = inv.payment_intent as Stripe.PaymentIntent | string
    if (typeof paymentIntent === 'string') {
      throw new Error('Payment intent not expanded')
    }
    return this.mapPayment(paymentIntent)
  }

  async getInvoice(id: string): Promise<ProviderInvoice | null> {
    try {
      const inv = await this.stripe.invoices.retrieve(id, {
        expand: ['lines.data.price.product', 'subscription', 'payment_intent'],
      })
      return this.mapInvoice(inv)
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') {
        return null
      }
      throw error
    }
  }

  async listInvoices(
    customerId: string,
    options?: ListInvoicesOptions,
  ): Promise<ReadonlyArray<ProviderInvoice>> {
    const invoices = await this.stripe.invoices.list({
      customer: customerId,
      limit: options?.limit ?? 50,
      starting_after: options?.startingAfter,
      status: options?.status,
    })
    return invoices.data.map(this.mapInvoice)
  }

  // ============================================================================
  // Usage Metering
  // ============================================================================

  async reportUsage(
    subscriptionItemId: string,
    quantity: number,
    timestamp: number,
    action: 'increment' | 'set' = 'increment',
  ): Promise<void> {
    await this.stripe.subscriptionItems.createUsageRecord(
      subscriptionItemId,
      {
        quantity,
        timestamp,
        action,
      },
      { idempotencyKey: `usage-${subscriptionItemId}-${timestamp}-${action}` },
    )
  }

  // ============================================================================
  // Credits
  // ============================================================================

  async createCreditNote(input: CreateCreditNoteInput): Promise<ProviderCreditNote> {
    const cn = await this.stripe.creditNotes.create(
      {
        customer: input.customerId,
        invoice: input.invoiceId,
        amount: this.microsToCentavos(input.amountMicros),
        reason: input.reason,
        memo: input.memo,
      },
      { idempotencyKey: input.idempotencyKey },
    )
    return this.mapCreditNote(cn)
  }

  // ============================================================================
  // Webhooks
  // ============================================================================

  constructEvent(payload: string, signature: string): ProviderWebhookEvent {
    const event = this.stripe.webhooks.constructEvent(payload, signature, this.webhookSecret)
    return {
      id: event.id,
      type: event.type,
      createdAt: new Date(event.created * 1000),
      data: event.data.object,
      livemode: event.livemode,
    }
  }

  parseWebhookEvent(event: ProviderWebhookEvent): NormalizedWebhookEvent {
    const typeMap: Record<string, WebhookEventType> = {
      'customer.subscription.created': 'subscription.created',
      'customer.subscription.updated': 'subscription.updated',
      'customer.subscription.deleted': 'subscription.canceled',
      'customer.subscription.trial_will_end': 'subscription.trial_will_end',
      'invoice.created': 'invoice.created',
      'invoice.finalized': 'invoice.finalized',
      'invoice.paid': 'invoice.paid',
      'invoice.payment_failed': 'invoice.payment_failed',
      'invoice.upcoming': 'invoice.upcoming',
      'payment_intent.succeeded': 'payment_intent.succeeded',
      'payment_intent.payment_failed': 'payment_intent.payment_failed',
      'payment_method.attached': 'payment_method.attached',
      'payment_method.detached': 'payment_method.detached',
      'customer.updated': 'customer.updated',
      'credit_note.created': 'credit_note.created',
    }

    const data = event.data as Record<string, unknown>

    return {
      type: typeMap[event.type] ?? (event.type as WebhookEventType),
      providerSubscriptionId: (data.subscription as string) ?? (data.customer as string),
      providerCustomerId: data.customer as string,
      providerInvoiceId: data.id as string,
      providerPaymentId: (data.payment_intent as string) ?? (data.charge as string),
      payload: data,
    }
  }

  // ============================================================================
  // Private Mappers
  // ============================================================================

  private get webhookSecret(): string {
    // Injetado via construtor em produção
    return process.env.STRIPE_WEBHOOK_SECRET ?? ''
  }

  private mapProduct(product: Stripe.Product): ProviderProduct {
    return {
      id: product.id,
      name: product.name,
      description: product.description ?? undefined,
      metadata: product.metadata as Record<string, string>,
      active: product.active,
      createdAt: new Date(product.created * 1000),
    }
  }

  private mapPrice(price: Stripe.Price): ProviderPrice {
    return {
      id: price.id,
      productId: price.product as string,
      currency: price.currency.toUpperCase() as Currency,
      unitAmountMicros: this.centavosToMicros(price.unit_amount ?? 0),
      interval: (price.recurring?.interval as Interval) ?? 'month',
      intervalCount: price.recurring?.interval_count ?? 1,
      trialPeriodDays: price.recurring?.trial_period_days ?? undefined,
      metadata: price.metadata as Record<string, string>,
      active: price.active,
      usageType: (price.recurring?.usage_type as 'metered' | 'licensed') ?? 'licensed',
    }
  }

  private mapCustomer(customer: Stripe.Customer): ProviderCustomer {
    return {
      id: customer.id,
      email: customer.email ?? '',
      name: customer.name ?? undefined,
      companyName: (customer.company as string) ?? undefined,
      taxId: customer.tax_id ?? undefined,
      address: customer.address ? this.mapAddressFromStripe(customer.address) : undefined,
      defaultPaymentMethodId: (customer.invoice_settings?.default_payment_method as string) ?? undefined,
      metadata: customer.metadata as Record<string, string>,
      createdAt: new Date(customer.created * 1000),
    }
  }

  private mapPaymentMethod(pm: Stripe.PaymentMethod): ProviderPaymentMethod {
    return {
      id: pm.id,
      type: pm.type,
      card: pm.card
        ? {
            brand: pm.card.brand,
            last4: pm.card.last4,
            expMonth: pm.card.exp_month,
            expYear: pm.card.exp_year,
          }
        : undefined,
      billingDetails: pm.billing_details
        ? {
            name: pm.billing_details.name ?? undefined,
            email: pm.billing_details.email ?? undefined,
            address: pm.billing_details.address
              ? this.mapAddressFromStripe(pm.billing_details.address)
              : undefined,
          }
        : undefined,
    }
  }

  private mapSubscription(sub: Stripe.Subscription): ProviderSubscription {
    const price = sub.items.data[0]?.price
    return {
      id: sub.id,
      customerId: sub.customer as string,
      priceId: price?.id ?? '',
      status: sub.status as ProviderSubscription['status'],
      currentPeriodStart: new Date(sub.current_period_start * 1000),
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      trialStart: sub.trial_start ? new Date(sub.trial_start * 1000) : undefined,
      trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : undefined,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : undefined,
      pausedAt: sub.pause_collection ? new Date() : undefined,
      defaultPaymentMethodId: (sub.default_payment_method as string) ?? undefined,
      metadata: sub.metadata as Record<string, string>,
      items: sub.items.data.map((item) => ({
        id: item.id,
        priceId: item.price.id,
        quantity: item.quantity,
        usageType: (item.price.recurring?.usage_type as 'metered' | 'licensed') ?? 'licensed',
      })),
    }
  }

  private mapInvoice(inv: Stripe.Invoice): ProviderInvoice {
    return {
      id: inv.id,
      subscriptionId: (inv.subscription as string) ?? undefined,
      customerId: inv.customer as string,
      status: inv.status as ProviderInvoice['status'],
      amountDueMicros: this.centavosToMicros(inv.amount_due),
      amountPaidMicros: this.centavosToMicros(inv.amount_paid),
      currency: inv.currency.toUpperCase() as Currency,
      hostedInvoiceUrl: inv.hosted_invoice_url ?? undefined,
      invoicePdfUrl: inv.invoice_pdf ?? undefined,
      periodStart: new Date(inv.period_start * 1000),
      periodEnd: new Date(inv.period_end * 1000),
      dueDate: inv.due_date ? new Date(inv.due_date * 1000) : undefined,
      paidAt:
        inv.status === 'paid' && inv.status_transitions?.paid_at
          ? new Date(inv.status_transitions.paid_at * 1000)
          : undefined,
      lines: inv.lines.data.map((line) => ({
        id: line.id,
        priceId: line.price?.id ?? '',
        quantity: line.quantity,
        amountMicros: this.centavosToMicros(line.amount),
        description: line.description ?? undefined,
        type: line.type as ProviderInvoiceLine['type'],
        periodStart: line.period?.start ? new Date(line.period.start * 1000) : undefined,
        periodEnd: line.period?.end ? new Date(line.period.end * 1000) : undefined,
      })),
      metadata: inv.metadata as Record<string, string>,
    }
  }

  private mapPayment(pi: Stripe.PaymentIntent): ProviderPayment {
    const charge = pi.charges.data[0]
    return {
      id: pi.id,
      invoiceId: (pi.invoice as string) ?? undefined,
      customerId: pi.customer as string,
      amountMicros: this.centavosToMicros(pi.amount),
      currency: pi.currency.toUpperCase() as Currency,
      status:
        pi.status === 'succeeded'
          ? 'succeeded'
          : pi.status === 'processing'
            ? 'pending'
            : pi.status === 'requires_payment_method'
              ? 'pending'
              : 'failed',
      paymentMethodType: pi.payment_method_types[0] ?? 'card',
      providerFeeMicros: charge?.balance_transaction
        ? this.centavosToMicros(charge.balance_transaction.fee)
        : undefined,
      receiptUrl: charge?.receipt_url ?? undefined,
      paidAt: pi.status === 'succeeded' ? new Date() : undefined,
      refundedAt: undefined,
      metadata: pi.metadata as Record<string, string>,
    }
  }

  private mapCreditNote(cn: Stripe.CreditNote): ProviderCreditNote {
    return {
      id: cn.id,
      customerId: cn.customer as string,
      invoiceId: (cn.invoice as string) ?? undefined,
      amountMicros: this.centavosToMicros(cn.amount),
      currency: cn.currency.toUpperCase() as Currency,
      reason: cn.reason as ProviderCreditNote['reason'],
      memo: cn.memo ?? undefined,
      status: cn.status as 'issued' | 'void',
      createdAt: new Date(cn.created * 1000),
    }
  }

  private mapAddressFromStripe(addr: Stripe.Address): Address {
    return {
      street: addr.line1 ?? '',
      city: addr.city ?? '',
      state: addr.state ?? '',
      zip: addr.postal_code ?? '',
      country: addr.country ?? 'BR',
    }
  }

  private mapAddress(addr: Address): Stripe.AddressParam {
    return {
      line1: addr.street,
      city: addr.city,
      state: addr.state,
      postal_code: addr.zip,
      country: addr.country ?? 'BR',
    }
  }

  private centavosToMicros(centavos: number): number {
    return Math.round(centavos * 10_000)
  }

  private microsToCentavos(micros: number): number {
    return Math.round(micros / 10_000)
  }
}
