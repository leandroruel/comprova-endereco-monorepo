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
  ProviderInvoiceLine,
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

/**
 * Status do PaymentIntent → status local. Estados intermediários de
 * confirmação são "pending"; tudo não mapeado é "failed".
 */
const paymentStatusByIntentStatus: Record<string, ProviderPayment['status']> = {
  succeeded: 'succeeded',
  processing: 'pending',
  requires_payment_method: 'pending',
  requires_action: 'pending',
  requires_confirmation: 'pending',
  requires_capture: 'pending',
}

/**
 * Tipo da linha de fatura no Stripe → tipo no domínio. `invoiceitem` é um
 * item avulso (cobrança pontual), não uma assinatura.
 */
const invoiceLineTypeByStripe: Record<string, ProviderInvoiceLine['type']> = {
  subscription: 'subscription',
  invoiceitem: 'charge',
  usage: 'usage',
  credit: 'credit',
  proration: 'proration',
  tax: 'tax',
  discount: 'discount',
  charge: 'charge',
  pending: 'pending',
}

export interface StripeProviderConfig {
  readonly secretKey: string
  readonly webhookSecret: string
}

/**
 * Preserva no memo um motivo que a API do Stripe não aceita como `reason`
 * (ex.: `other`). Idempotente: não duplica a anotação se o memo já a traz.
 */
function composeMemoWithReason(reason: string, memo: string | undefined): string {
  const tag = `reason: ${reason}`
  if (memo?.includes(tag)) {
    return memo
  }
  return `[${tag}]${memo ? ` ${memo}` : ''}`
}

export class StripeProvider implements BillingProvider {
  readonly name = 'stripe'
  readonly supportedCurrencies: readonly Currency[] = ['BRL', 'USD', 'EUR']
  readonly supportedIntervals: readonly Interval[] = ['month', 'year']
  readonly supportedPaymentMethods = ['card', 'boleto', 'pix', 'bank_transfer', 'link']

  private readonly stripe: Stripe
  private readonly webhookSecret: string

  constructor(config: StripeProviderConfig) {
    if (!config.webhookSecret) {
      throw new Error('webhookSecret is required')
    }
    this.webhookSecret = config.webhookSecret
    this.stripe = new Stripe(config.secretKey, {
      apiVersion: '2024-06-20',
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

  async archivePrice(id: string): Promise<void> {
    await this.stripe.prices.update(id, { active: false })
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
          // Cumprir o contrato de entrada: trial padrão configurado no Price
          // (usado com trial_from_plan), além do trial por subscription.
          trial_period_days: input.trialPeriodDays,
          usage_type: input.usageType,
        },
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

  async detachPaymentMethod(_customerId: string, paymentMethodId: string): Promise<void> {
    await this.stripe.paymentMethods.detach(paymentMethodId)
  }

  async listPaymentMethods(customerId: string): Promise<ReadonlyArray<ProviderPaymentMethod>> {
    const methods = await this.stripe.paymentMethods.list({
      customer: customerId,
      type: 'card',
    })
    return methods.data.map((m) => this.mapPaymentMethod(m))
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

    if (input.priceId || input.quantity !== undefined) {
      const currentSub = await this.stripe.subscriptions.retrieve(id)
      const itemId = currentSub.items.data[0]?.id
      if (!itemId) {
        throw new Error('Subscription has no items')
      }
      const updateItem: Stripe.SubscriptionUpdateParams.Item = { id: itemId }
      if (input.priceId) {
        updateItem.price = input.priceId
      }
      if (input.quantity !== undefined) {
        updateItem.quantity = input.quantity
      }
      updateParams.items = [updateItem]
      updateParams.proration_behavior = input.prorationBehavior ?? 'create_prorations'
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
    return this.retrieveOrNull(async () => {
      const subscription = await this.stripe.subscriptions.retrieve(id, {
        expand: ['default_payment_method', 'items.data.price.product'],
      })
      return this.mapSubscription(subscription)
    })
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
    const paymentIntent = inv.payment_intent as Stripe.PaymentIntent | string
    if (typeof paymentIntent === 'string') {
      throw new Error('Payment intent not expanded')
    }
    return this.mapPayment(paymentIntent)
  }

  async getInvoice(id: string): Promise<ProviderInvoice | null> {
    return this.retrieveOrNull(async () => {
      const inv = await this.stripe.invoices.retrieve(id, {
        expand: ['lines.data.price.product', 'subscription', 'payment_intent'],
      })
      return this.mapInvoice(inv)
    })
  }

  async listInvoices(
    customerId: string,
    options?: ListInvoicesOptions,
  ): Promise<ReadonlyArray<ProviderInvoice>> {
    const invoices = await this.stripe.invoices.list({
      customer: customerId,
      limit: options?.limit ?? 50,
      starting_after: options?.startingAfter,
      status: options?.status as Stripe.InvoiceListParams.Status | undefined,
    })
    return invoices.data.map((inv) => this.mapInvoice(inv))
  }

  async getPayment(id: string): Promise<ProviderPayment | null> {
    return this.retrieveOrNull(async () => {
      // latest_charge não vem expandido por padrão em PaymentIntent.retrieve;
      // balance_transaction também não — ambos são necessários para receipt_url
      // e a tarifa do provider.
      const pi = await this.stripe.paymentIntents.retrieve(id, {
        expand: ['latest_charge', 'latest_charge.balance_transaction'],
      })
      return this.mapPayment(pi)
    })
  }

  /**
   * Executa uma retrieve no Stripe convertendo `resource_missing` em `null`
   * (objeto não existe mais no provider); demais erros propagam.
   */
  private async retrieveOrNull<T>(retrieve: () => Promise<T>): Promise<T | null> {
    try {
      return await retrieve()
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') {
        return null
      }
      throw error
    }
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
    if (!input.invoiceId) {
      throw new Error('invoiceId is required for credit notes')
    }

    // Mapeamento exaustivo: `other` não é motivo aceito pela API do Stripe
    // (v16), então o campo `reason` é omitido e o motivo real é preservado no
    // memo — nunca rotulado incorretamente como `duplicate`.
    const reasonByInput: Record<
      ProviderCreditNote['reason'],
      Stripe.CreditNoteCreateParams.Reason | undefined
    > = {
      duplicate: 'duplicate',
      fraudulent: 'fraudulent',
      order_change: 'order_change',
      product_unsatisfactory: 'product_unsatisfactory',
      other: undefined,
    }

    const stripeReason = reasonByInput[input.reason]
    const memo = stripeReason === undefined ? composeMemoWithReason(input.reason, input.memo) : input.memo

    const cn = await this.stripe.creditNotes.create(
      {
        invoice: input.invoiceId,
        amount: this.microsToCentavos(input.amountMicros),
        reason: stripeReason,
        memo,
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
      'customer.subscription.paused': 'subscription.updated',
      'customer.subscription.resumed': 'subscription.updated',
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

    // Determine providerSubscriptionId based on event type
    const providerSubscriptionId = this.subscriptionIdForEvent(event.type, data)

    // customer.updated carries the customer ID in data.id, not data.customer.
    const providerCustomerId =
      event.type === 'customer.updated'
        ? (this.extractId(data.id) ?? undefined)
        : (this.extractId(data.customer) ?? undefined)

    // payment_method events carry the method itself in data.id.
    const providerPaymentMethodId = event.type.startsWith('payment_method.')
      ? (this.extractId(data.id) ?? undefined)
      : undefined

    return {
      type: typeMap[event.type] ?? (event.type as WebhookEventType),
      providerName: this.name,
      providerEventId: event.id,
      providerSubscriptionId,
      providerCustomerId,
      providerInvoiceId: event.type.startsWith('invoice.')
        ? (this.extractId(data.id) ?? undefined)
        : undefined,
      providerPaymentId: this.extractPaymentId(data, event.type),
      providerPaymentMethodId,
      payload: data,
    }
  }

  /**
   * Resolve o ID da subscription envolvida no evento: eventos de subscription
   * carregam o objeto em `data.id`; eventos de invoice em `data.subscription`.
   */
  private subscriptionIdForEvent(type: string, data: Record<string, unknown>): string | undefined {
    if (type.startsWith('customer.subscription.')) {
      return this.extractId(data.id) ?? undefined
    }
    if (type.startsWith('invoice.')) {
      return this.extractId(data.subscription) ?? undefined
    }
    return undefined
  }

  private extractPaymentId(data: Record<string, unknown>, type: string): string | undefined {
    if (type === 'payment_intent.succeeded' || type === 'payment_intent.payment_failed') {
      return this.extractId(data.id) ?? undefined
    }
    return this.extractId(data.payment_intent) ?? this.extractId(data.charge) ?? undefined
  }

  /**
   * Extrai o ID de um campo que o Stripe pode devolver como string ou como
   * objeto expandido.
   */
  private extractId(value: unknown): string | null {
    if (typeof value === 'string') {
      return value
    }
    if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
      return (value as { id: string }).id
    }
    return null
  }

  // ============================================================================
  // Private Mappers
  // ============================================================================

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
      companyName: customer.metadata?.company_name ?? undefined,
      taxId: customer.tax_ids?.data[0]?.value ?? undefined,
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
    // Map Stripe's incomplete_expired to canceled locally
    const status =
      sub.status === 'incomplete_expired' ? 'canceled' : (sub.status as ProviderSubscription['status'])

    // `pause_collection` does NOT change the subscription status in Stripe:
    // the subscription stays `active` while payment collection is paused.
    const pauseCollection = sub.pause_collection
      ? {
          behavior: sub.pause_collection.behavior,
          resumesAt: sub.pause_collection.resumes_at
            ? new Date(sub.pause_collection.resumes_at * 1000)
            : null,
        }
      : null

    // Stripe does not expose the instant a collection pause started. When
    // paused, `pausedAt` is undefined so the service preserves the local
    // value instead of fabricating a date on every sync. When not paused,
    // `null` explicitly clears any stale local value.
    const pausedAt = sub.status === 'paused' || pauseCollection ? undefined : null

    return {
      id: sub.id,
      customerId: this.extractId(sub.customer) ?? '',
      priceId: price?.id ?? '',
      status,
      currentPeriodStart: new Date(sub.current_period_start * 1000),
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      trialStart: sub.trial_start ? new Date(sub.trial_start * 1000) : null,
      trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
      pausedAt,
      defaultPaymentMethodId: this.extractId(sub.default_payment_method),
      pauseCollection,
      metadata: sub.metadata as Record<string, string>,
      items: sub.items.data.map((item) => ({
        id: item.id,
        priceId: item.price.id,
        quantity: item.quantity ?? 1,
        usageType: (item.price.recurring?.usage_type as 'metered' | 'licensed') ?? 'licensed',
      })),
    }
  }

  private mapInvoice(inv: Stripe.Invoice): ProviderInvoice {
    return {
      id: inv.id,
      subscriptionId: this.extractId(inv.subscription) ?? undefined,
      customerId: this.extractId(inv.customer) ?? '',
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
      lines: inv.lines.data.map((line) => this.mapInvoiceLine(line)),
      metadata: inv.metadata as Record<string, string>,
    }
  }

  private mapInvoiceLine(line: Stripe.InvoiceLineItem): ProviderInvoiceLine {
    return {
      id: line.id,
      priceId: line.price?.id ?? '',
      quantity: line.quantity ?? 0,
      amountMicros: this.centavosToMicros(line.amount),
      description: line.description ?? undefined,
      // In the Stripe API version used here, `line.type` only distinguishes
      // `subscription` from `invoiceitem`; proration is a separate boolean.
      type: line.proration ? 'proration' : this.mapInvoiceLineType(line.type),
      periodStart: line.period ? new Date(line.period.start * 1000) : undefined,
      periodEnd: line.period ? new Date(line.period.end * 1000) : undefined,
    }
  }

  /**
   * Mapeamento explícito entre os tipos de linha do Stripe e o domínio.
   *
   * Um tipo desconhecido falha de forma rastreável em vez de ser rotulado
   * como `charge` (o que alteraria o significado contábil da linha).
   */
  private mapInvoiceLineType(type: string): ProviderInvoiceLine['type'] {
    const lineType = invoiceLineTypeByStripe[type]

    if (lineType === undefined) {
      throw new Error(`Unsupported Stripe invoice line type: ${type}`)
    }
    return lineType
  }

  private mapPayment(pi: Stripe.PaymentIntent): ProviderPayment {
    // `latest_charge` é string (ID) ou Charge expandido, dependendo da
    // expansão solicitada. Não confiar em `charges` (não vem expandido por
    // padrão em PaymentIntent.retrieve).
    const charge = typeof pi.latest_charge === 'object' && pi.latest_charge !== null ? pi.latest_charge : null
    // Fee só existe com balance_transaction expandido; sem expansão o valor
    // fica indefinido em vez de sincronizar um zero enganoso.
    const balanceTransaction = charge?.balance_transaction
    const providerFeeMicros =
      typeof balanceTransaction === 'object' && balanceTransaction !== null
        ? this.centavosToMicros(balanceTransaction.fee)
        : undefined
    // Data real do pagamento: instante do charge no provider, nunca o relógio
    // do processo de sincronização.
    const paidAt = pi.status === 'succeeded' && charge ? new Date(charge.created * 1000) : undefined

    return {
      id: pi.id,
      invoiceId: (pi.invoice as string) ?? undefined,
      customerId: pi.customer as string,
      amountMicros: this.centavosToMicros(pi.amount),
      currency: pi.currency.toUpperCase() as Currency,
      status: paymentStatusByIntentStatus[pi.status] ?? 'failed',
      paymentMethodType: pi.payment_method_types[0] ?? 'card',
      providerFeeMicros,
      receiptUrl: charge?.receipt_url ?? undefined,
      paidAt,
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
