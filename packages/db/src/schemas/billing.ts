/**
 * Billing Schema — Tabelas de billing (planos, assinaturas, faturas, pagamentos, webhooks).
 *
 * Criadas pela migration 0094 (provider abstraction layer).
 */

import { bigint, boolean, index, integer, pgTable, text, timestamp, unique, uuid, jsonb, pgEnum } from 'drizzle-orm/pg-core'
import { tenant } from './tenancy.js'
import { adminAuthUser } from './auth.js'

// ============================================================================
// Enums
// ============================================================================

export const billingPlanStatusEnum = pgEnum('billing_plan_status', ['active', 'archived', 'deprecated'])
export const subscriptionStatusEnum = pgEnum('subscription_status', ['incomplete', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'])
export const invoiceStatusEnum = pgEnum('invoice_status', ['draft', 'open', 'paid', 'void', 'uncollectible', 'pending'])
export const paymentStatusEnum = pgEnum('payment_status', ['pending', 'succeeded', 'failed', 'refunded', 'partially_refunded'])

// ============================================================================
// billing_plan — Planos de billing configurados pelo admin
// ============================================================================

export const billingPlan = pgTable(
  'billing_plan',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    description: text('description'),
    billingModel: text('billing_model').notNull(), // 'prepaid' | 'postpaid' | 'hybrid'
    currency: text('currency').notNull().default('BRL'),
    monthlyPriceMicros: bigint('monthly_price_micros', { mode: 'number' }).notNull().default(0),
    includedValidations: integer('included_validations').notNull().default(0),
    includedCredentials: integer('included_credentials').notNull().default(0),
    pricePerValidationMicros: bigint('price_per_validation_micros', { mode: 'number' }).notNull().default(0),
    pricePerCredentialMicros: bigint('price_per_credential_micros', { mode: 'number' }).notNull().default(0),
    maxValidationsPerMonth: integer('max_validations_per_month'),
    maxCredentialsPerMonth: integer('max_credentials_per_month'),
    maxApiKeys: integer('max_api_keys'),
    maxWebhooks: integer('max_webhooks'),
    features: jsonb('features').notNull().default('{}'),
    status: billingPlanStatusEnum('status').notNull().default('active'),
    metadata: jsonb('metadata').notNull().default('{}'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    // Provider fields (migration 0094)
    providerName: text('provider_name').notNull().default('stripe'),
    providerProductId: text('provider_product_id'),
    providerPriceId: text('provider_price_id'),
    interval: text('interval').notNull().default('month'),
    intervalCount: integer('interval_count').notNull().default(1),
    trialPeriodDays: integer('trial_period_days').default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdByAdminId: text('created_by_admin_id').references(() => adminAuthUser.id),
  },
  (t) => [
    index('idx_billing_plan_active_provider').on(t.isActive, t.providerName),
    unique('uq_billing_plan_provider_price').on(t.providerName, t.providerPriceId),
  ],
)

export type BillingPlan = typeof billingPlan.$inferSelect
export type NewBillingPlan = typeof billingPlan.$inferInsert

// ============================================================================
// tenant_subscription — Assinaturas ativas dos tenants
// ============================================================================

export const tenantSubscription = pgTable(
  'tenant_subscription',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    planId: uuid('plan_id')
      .notNull()
      .references(() => billingPlan.id),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    status: subscriptionStatusEnum('status').notNull().default('incomplete'),
    billingCycleAnchor: timestamp('billing_cycle_anchor', { withTimezone: true }).notNull(),
    agreedPriceMicros: bigint('agreed_price_micros', { mode: 'number' }).notNull().default(0),
    currency: text('currency').notNull().default('BRL'),
    validationsUsed: integer('validations_used').notNull().default(0),
    credentialsUsed: integer('credentials_used').notNull().default(0),
    trialEnd: timestamp('trial_end', { withTimezone: true }),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    metadata: jsonb('metadata').notNull().default('{}'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    // Provider fields (migration 0094)
    providerName: text('provider_name').notNull().default('stripe'),
    providerCustomerId: text('provider_customer_id'),
    providerSubscriptionId: text('provider_subscription_id').unique(),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    trialStart: timestamp('trial_start', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').default(false),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    paymentMethodId: text('payment_method_id'),
    billingContactEmail: text('billing_contact_email'),
    billingCompanyName: text('billing_company_name'),
    billingCnpj: text('billing_cnpj'),
    billingAddress: jsonb('billing_address'),
  },
  (t) => [
    index('idx_tenant_subscription_tenant_provider').on(t.tenantId, t.providerName),
    index('idx_tenant_subscription_provider_sub').on(t.providerName, t.providerSubscriptionId),
    index('idx_tenant_subscription_status').on(t.status),
  ],
)

export type TenantSubscription = typeof tenantSubscription.$inferSelect
export type NewTenantSubscription = typeof tenantSubscription.$inferInsert

// ============================================================================
// invoice — Faturas geradas pelo provider
// ============================================================================

export const invoice = pgTable(
  'invoice',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    subscriptionId: uuid('subscription_id')
      .references(() => tenantSubscription.id, { onDelete: 'set null' }),
    number: text('number').notNull(),
    status: invoiceStatusEnum('status').notNull().default('draft'),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    subtotalMicros: bigint('subtotal_micros', { mode: 'number' }).notNull().default(0),
    discountMicros: bigint('discount_micros', { mode: 'number' }).notNull().default(0),
    taxMicros: bigint('tax_micros', { mode: 'number' }).notNull().default(0),
    totalMicros: bigint('total_micros', { mode: 'number' }).notNull().default(0),
    paidMicros: bigint('paid_micros', { mode: 'number' }).notNull().default(0),
    currency: text('currency').notNull().default('BRL'),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    paymentMethod: text('payment_method'),
    paymentReference: text('payment_reference'),
    paidMicrosTotal: bigint('paid_micros_total', { mode: 'number' }).notNull().default(0),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    canceledReason: text('canceled_reason'),
    refundedMicros: bigint('refunded_micros', { mode: 'number' }).notNull().default(0),
    items: jsonb('items').notNull().default('[]'),
    metadata: jsonb('metadata').notNull().default('{}'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    // Provider fields (migration 0094)
    providerName: text('provider_name').notNull().default('stripe'),
    providerInvoiceId: text('provider_invoice_id').unique(),
    providerInvoicePdf: text('provider_invoice_pdf'),
    amountDueMicros: bigint('amount_due_micros', { mode: 'number' }),
    amountPaidMicros: bigint('amount_paid_micros', { mode: 'number' }),
    hostedInvoiceUrl: text('hosted_invoice_url'),
    invoicePdfUrl: text('invoice_pdf_url'),
    dueDate: timestamp('due_date', { withTimezone: true }),
  },
  (t) => [
    index('idx_invoice_provider').on(t.providerName, t.providerInvoiceId),
    index('idx_invoice_subscription_status').on(t.subscriptionId, t.status),
    index('idx_invoice_tenant_status').on(t.tenantId, t.status),
    unique('uq_invoice_tenant_number').on(t.tenantId, t.number),
  ],
)

export type Invoice = typeof invoice.$inferSelect
export type NewInvoice = typeof invoice.$inferInsert

// ============================================================================
// payment — Pagamentos processados
// ============================================================================

export const payment = pgTable(
  'payment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    invoiceId: uuid('invoice_id')
      .references(() => invoice.id, { onDelete: 'set null' }),
    amountMicros: bigint('amount_micros', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('BRL'),
    status: paymentStatusEnum('status').notNull().default('pending'),
    provider: text('provider').notNull(),
    providerPaymentId: text('provider_payment_id').unique(),
    providerData: jsonb('provider_data').notNull().default('{}'),
    referenceType: text('reference_type'),
    referenceId: uuid('reference_id'),
    idempotencyKey: text('idempotency_key'),
    method: text('method'),
    metadata: jsonb('metadata').notNull().default('{}'),
    initiatedAt: timestamp('initiated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    // Provider fields (migration 0094)
    providerName: text('provider_name').notNull().default('stripe'),
    providerChargeId: text('provider_charge_id'),
    paymentMethodType: text('payment_method_type'),
    providerFeeMicros: bigint('provider_fee_micros', { mode: 'number' }),
    receiptUrl: text('receipt_url'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_payment_provider').on(t.providerName, t.providerPaymentId),
    index('idx_payment_invoice_status').on(t.invoiceId, t.status),
    index('idx_payment_tenant_status').on(t.tenantId, t.status),
  ],
)

export type Payment = typeof payment.$inferSelect
export type NewPayment = typeof payment.$inferInsert

// ============================================================================
// provider_webhook_event — Idempotência de webhooks
// ============================================================================

export const providerWebhookEvent = pgTable(
  'provider_webhook_event',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    providerName: text('provider_name').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    processingError: text('processing_error'),
    retryCount: integer('retry_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('provider_webhook_event_provider_name_provider_event_id_key').on(t.providerName, t.providerEventId),
    index('idx_provider_webhook_event_created').on(t.createdAt),
  ],
)

export type ProviderWebhookEvent = typeof providerWebhookEvent.$inferSelect
export type NewProviderWebhookEvent = typeof providerWebhookEvent.$inferInsert