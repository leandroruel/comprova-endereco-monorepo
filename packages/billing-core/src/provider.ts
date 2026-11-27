/**
 * Core Billing Provider Abstraction
 *
 * Stripe, Mercado Pago, Asaas, etc. implementam esta interface.
 * O core do sistema (PlanService, SubscriptionService, etc.) depende
 * apenas desta interface, não de implementações concretas.
 */

// ============================================================================
// Tipos Locais (evita dependência de @comprova/contracts)
// ============================================================================

export interface Address {
  readonly street: string
  readonly city: string
  readonly state: string
  readonly zip: string
  readonly country?: string
}

// ============================================================================
// Tipos Básicos (Provider-Agnósticos)
// ============================================================================

export type Currency = 'BRL' | 'USD' | 'EUR'
export type Interval = 'month' | 'year'

export type SubscriptionStatus =
  'incomplete' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused' | 'incomplete_expired'

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible' | 'pending'

export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'refunded' | 'partially_refunded'

export type WebhookEventType =
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.canceled'
  | 'subscription.trial_will_end'
  | 'invoice.created'
  | 'invoice.finalized'
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | 'invoice.upcoming'
  | 'payment_intent.succeeded'
  | 'payment_intent.payment_failed'
  | 'payment_method.attached'
  | 'payment_method.detached'
  | 'customer.updated'
  | 'credit_note.created'

// ============================================================================
// Plan Features & Pricing (Shared Types)
// ============================================================================

export interface PlanFeatures {
  readonly validationsIncluded: number
  readonly overagePriceMicros: number
  readonly debitMode: 'strict' | 'grace'
  readonly currency: Currency
  readonly trialDays?: number
  readonly features: readonly string[]
}

export interface PlanPricing {
  readonly amountMicros: number
  readonly debitMode: 'strict' | 'grace'
  readonly validationsIncluded: number
  readonly overagePriceMicros: number
  readonly currency: Currency
  readonly providerPriceId: string
  readonly usageType: 'metered' | 'licensed'
}

// ============================================================================
// Objetos de Domínio (Retornados pelos Providers)
// ============================================================================

export interface ProviderProduct {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly metadata: Readonly<Record<string, string>>
  readonly active: boolean
  readonly createdAt: Date
}

export interface ProviderPrice {
  readonly id: string
  readonly productId: string
  readonly currency: Currency
  readonly unitAmountMicros: number
  readonly interval: Interval
  readonly intervalCount: number
  readonly trialPeriodDays?: number
  readonly metadata: Readonly<Record<string, string>>
  readonly active: boolean
  readonly usageType?: 'metered' | 'licensed'
}

export interface ProviderCustomer {
  readonly id: string
  readonly email: string
  readonly name?: string
  readonly companyName?: string
  readonly taxId?: string
  readonly address?: Address
  readonly defaultPaymentMethodId?: string
  readonly metadata: Readonly<Record<string, string>>
  readonly createdAt: Date
}

export interface ProviderPaymentMethod {
  readonly id: string
  readonly type: string
  readonly card?: {
    readonly brand: string
    readonly last4: string
    readonly expMonth: number
    readonly expYear: number
  }
  readonly billingDetails?: {
    readonly name?: string
    readonly email?: string
    readonly address?: Address
  }
}

export interface ProviderSubscriptionItem {
  readonly id: string
  readonly priceId: string
  readonly quantity: number
  readonly usageType?: 'metered' | 'licensed'
}

export interface ProviderSubscription {
  readonly id: string
  readonly customerId: string
  readonly priceId: string
  readonly status: SubscriptionStatus
  readonly currentPeriodStart: Date
  readonly currentPeriodEnd: Date
  readonly trialStart?: Date
  readonly trialEnd?: Date
  readonly cancelAtPeriodEnd: boolean
  readonly canceledAt?: Date
  readonly pausedAt?: Date
  readonly defaultPaymentMethodId?: string
  readonly metadata: Readonly<Record<string, string>>
  readonly items: ReadonlyArray<ProviderSubscriptionItem>
}

export interface ProviderInvoiceLine {
  readonly id: string
  readonly priceId: string
  readonly quantity: number
  readonly amountMicros: number
  readonly description?: string
  readonly type: 'subscription' | 'usage' | 'credit' | 'proration'
  readonly periodStart?: Date
  readonly periodEnd?: Date
}

export interface ProviderInvoice {
  readonly id: string
  readonly subscriptionId?: string
  readonly customerId: string
  readonly status: InvoiceStatus
  readonly amountDueMicros: number
  readonly amountPaidMicros: number
  readonly currency: Currency
  readonly hostedInvoiceUrl?: string
  readonly invoicePdfUrl?: string
  readonly periodStart: Date
  readonly periodEnd: Date
  readonly dueDate?: Date
  readonly paidAt?: Date
  readonly lines: ReadonlyArray<ProviderInvoiceLine>
  readonly metadata: Readonly<Record<string, string>>
}

export interface ProviderPayment {
  readonly id: string
  readonly invoiceId?: string
  readonly customerId: string
  readonly amountMicros: number
  readonly currency: Currency
  readonly status: PaymentStatus
  readonly paymentMethodType: string
  readonly providerFeeMicros?: number
  readonly receiptUrl?: string
  readonly paidAt?: Date
  readonly refundedAt?: Date
  readonly metadata: Readonly<Record<string, string>>
}

export interface ProviderCreditNote {
  readonly id: string
  readonly customerId: string
  readonly invoiceId?: string
  readonly amountMicros: number
  readonly currency: Currency
  readonly reason: 'duplicate' | 'fraudulent' | 'order_change' | 'product_unsatisfactory' | 'other'
  readonly memo?: string
  readonly status: 'issued' | 'void'
  readonly createdAt: Date
}

// ============================================================================
// Webhooks
// ============================================================================

export interface ProviderWebhookEvent {
  readonly id: string
  readonly type: string
  readonly createdAt: Date
  readonly data: unknown
  readonly livemode: boolean
}

export interface NormalizedWebhookEvent {
  readonly type: WebhookEventType
  readonly providerName: string
  readonly providerSubscriptionId?: string
  readonly providerCustomerId?: string
  readonly providerInvoiceId?: string
  readonly providerPaymentId?: string
  readonly payload: unknown
}

// ============================================================================
// Inputs (Parâmetros de Entrada)
// ============================================================================

export interface CreateProductInput {
  readonly name: string
  readonly description?: string
  readonly metadata?: Readonly<Record<string, string>>
  readonly idempotencyKey?: string
}

export interface UpdateProductInput {
  readonly name?: string
  readonly description?: string
  readonly metadata?: Readonly<Record<string, string>>
  readonly active?: boolean
  readonly idempotencyKey?: string
}

export interface CreatePriceInput {
  readonly currency: Currency
  readonly unitAmountMicros: number
  readonly interval: Interval
  readonly intervalCount?: number
  readonly trialPeriodDays?: number
  readonly usageType?: 'metered' | 'licensed'
  readonly metadata?: Readonly<Record<string, string>>
  readonly idempotencyKey?: string
}

export interface CreateCustomerInput {
  readonly email: string
  readonly name?: string
  readonly companyName?: string
  readonly taxId?: string
  readonly address?: Address
  readonly metadata?: Readonly<Record<string, string>>
  readonly idempotencyKey?: string
}

export interface UpdateCustomerInput {
  readonly email?: string
  readonly name?: string
  readonly companyName?: string
  readonly taxId?: string
  readonly address?: Address
  readonly metadata?: Readonly<Record<string, string>>
  readonly idempotencyKey?: string
}

export interface CreateSubscriptionInput {
  readonly customerId: string
  readonly priceId: string
  readonly quantity?: number
  readonly trialDays?: number
  readonly defaultPaymentMethodId?: string
  readonly paymentBehavior?: 'default_incomplete' | 'allow_incomplete'
  readonly metadata?: Readonly<Record<string, string>>
  readonly idempotencyKey?: string
}

export interface UpdateSubscriptionInput {
  readonly priceId?: string
  readonly quantity?: number
  readonly trialEnd?: Date
  readonly cancelAtPeriodEnd?: boolean
  readonly defaultPaymentMethodId?: string
  readonly metadata?: Readonly<Record<string, string>>
  readonly prorationBehavior?: 'create_prorations' | 'none' | 'always_invoice'
  readonly idempotencyKey?: string
}

export interface CreateInvoiceInput {
  readonly customerId: string
  readonly subscriptionId?: string
  readonly autoAdvance?: boolean
  readonly collectionMethod?: 'charge_automatically' | 'send_invoice'
  readonly daysUntilDue?: number
  readonly metadata?: Readonly<Record<string, string>>
  readonly idempotencyKey?: string
}

export interface ListInvoicesOptions {
  readonly limit?: number
  readonly startingAfter?: string
  readonly status?: InvoiceStatus
}

export interface CreateCreditNoteInput {
  readonly customerId: string
  readonly invoiceId?: string
  readonly amountMicros: number
  readonly currency: Currency
  readonly reason: 'duplicate' | 'fraudulent' | 'order_change' | 'product_unsatisfactory' | 'other'
  readonly memo?: string
  readonly idempotencyKey?: string
}

// ============================================================================
// Interface Principal do Provider
// ============================================================================

export interface BillingProvider {
  readonly name: string
  readonly supportedCurrencies: ReadonlyArray<Currency>
  readonly supportedIntervals: ReadonlyArray<Interval>
  readonly supportedPaymentMethods: ReadonlyArray<string>

  // ---------------------------------------------------------------------------
  // Products & Prices
  // ---------------------------------------------------------------------------
  createProduct(input: CreateProductInput): Promise<ProviderProduct>
  updateProduct(id: string, input: UpdateProductInput): Promise<void>
  archiveProduct(id: string): Promise<void>
  archivePrice(id: string): Promise<void>
  createPrice(productId: string, input: CreatePriceInput): Promise<ProviderPrice>

  // ---------------------------------------------------------------------------
  // Customers
  // ---------------------------------------------------------------------------
  createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer>
  updateCustomer(id: string, input: UpdateCustomerInput): Promise<void>
  attachPaymentMethod(customerId: string, paymentMethodId: string): Promise<void>
  detachPaymentMethod(customerId: string, paymentMethodId: string): Promise<void>
  listPaymentMethods(customerId: string): Promise<ReadonlyArray<ProviderPaymentMethod>>

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------
  createSubscription(input: CreateSubscriptionInput): Promise<ProviderSubscription>
  updateSubscription(id: string, input: UpdateSubscriptionInput): Promise<void>
  cancelSubscription(id: string, atPeriodEnd: boolean): Promise<void>
  pauseSubscription(id: string): Promise<void>
  resumeSubscription(id: string): Promise<void>
  getSubscription(id: string): Promise<ProviderSubscription | null>

  // ---------------------------------------------------------------------------
  // Invoices & Payments
  // ---------------------------------------------------------------------------
  createInvoice(input: CreateInvoiceInput): Promise<ProviderInvoice>
  finalizeInvoice(id: string): Promise<void>
  payInvoice(id: string, paymentMethodId?: string): Promise<ProviderPayment>
  getInvoice(id: string): Promise<ProviderInvoice | null>
  getPayment(id: string): Promise<ProviderPayment | null>
  listInvoices(customerId: string, options?: ListInvoicesOptions): Promise<ReadonlyArray<ProviderInvoice>>

  // ---------------------------------------------------------------------------
  // Usage Metering (Overages)
  // ---------------------------------------------------------------------------
  reportUsage(
    subscriptionItemId: string,
    quantity: number,
    timestamp: number,
    action?: 'increment' | 'set',
  ): Promise<void>

  // ---------------------------------------------------------------------------
  // Credits
  // ---------------------------------------------------------------------------
  createCreditNote(input: CreateCreditNoteInput): Promise<ProviderCreditNote>

  // ---------------------------------------------------------------------------
  // Webhooks
  // ---------------------------------------------------------------------------
  constructEvent(payload: string, signature: string): ProviderWebhookEvent
  parseWebhookEvent(event: ProviderWebhookEvent): NormalizedWebhookEvent
}
