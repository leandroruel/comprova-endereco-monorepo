# Plano de Integração Billing — Provider Abstraction Layer (Sales-Led + Admin-Activated)

> Base: PR #84 (Wallet, Ledger, Billing Plans, Subscriptions, Invoices, Payments, Credit Grants)
> Modelo: **Sales-led onboarding** → Admin ativa billing → Verifier completa onboarding com dados de cobrança
> Princípio: **Stripe é um provider, não o core** — abstração permite adicionar Mercado Pago, Asaas, PagSeguro, etc. depois.

---

## 1. Arquitetura: Provider Abstraction Layer

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              API Comprova (Core)                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  Domain Services (Provider-Agnostic)                                                │
│  ├── BillingPlanService       → CRUD planos, features, pricing rules                │
│  ├── SubscriptionService      → Estado da assinatura, transições, overages          │
│  ├── InvoiceService           → Faturas, pagamentos, reconciliação                  │
│  ├── CustomerService          → Dados empresa, métodos de pagamento, onboarding     │
│  └── UsageRatingService       → Rating de uso, aplicação de regras de plano         │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  BillingProvider Interface (packages/billing-core/src/provider.ts)                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │ interface BillingProvider {                                                  │   │
│  │   readonly name: string;                    // 'stripe' | 'mercadopago' ...   │   │
│  │   readonly supportedCurrencies: Currency[];                                  │   │
│  │   readonly supportedIntervals: Interval[];                                   │   │
│  │                                                                              │   │
│  │   // Products & Prices                                                       │   │
│  │   createProduct(input: CreateProductInput): Promise<ProviderProduct>;       │   │
│  │   updateProduct(id: string, input: UpdateProductInput): Promise<void>;      │   │
│  │   archiveProduct(id: string): Promise<void>;                                │   │
│  │   createPrice(productId: string, input: CreatePriceInput): Promise<ProviderPrice>;│
│  │                                                                              │   │
│  │   // Customers                                                               │   │
│  │   createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer>;    │   │
│  │   updateCustomer(id: string, input: UpdateCustomerInput): Promise<void>;    │   │
│  │   attachPaymentMethod(customerId: string, pmId: string): Promise<void>;     │   │
│  │   detachPaymentMethod(customerId: string, pmId: string): Promise<void>;     │   │
│  │                                                                              │   │
│  │   // Subscriptions                                                           │   │
│  │   createSubscription(input: CreateSubscriptionInput): Promise<ProviderSubscription>;│
│  │   updateSubscription(id: string, input: UpdateSubscriptionInput): Promise<void>;│
│  │   cancelSubscription(id: string, atPeriodEnd: boolean): Promise<void>;      │   │
│  │   getSubscription(id: string): Promise<ProviderSubscription | null>;        │   │
│  │                                                                              │   │
│  │   // Invoices & Payments                                                     │   │
│  │   createInvoice(input: CreateInvoiceInput): Promise<ProviderInvoice>;       │   │
│  │   finalizeInvoice(id: string): Promise<void>;                               │   │
│  │   payInvoice(id: string, paymentMethodId?: string): Promise<ProviderPayment>;│
│  │   getInvoice(id: string): Promise<ProviderInvoice | null>;                  │   │
│  │                                                                              │   │
│  │   // Usage Metering                                                          │   │
│  │   reportUsage(subscriptionItemId: string, quantity: number, timestamp: number): Promise<void>;│
│  │                                                                              │   │
│  │   // Credits                                                                 │   │
│  │   createCreditNote(input: CreateCreditNoteInput): Promise<ProviderCreditNote>;│
│  │                                                                              │   │
│  │   // Webhooks                                                                │   │
│  │   constructEvent(payload: string, signature: string): ProviderWebhookEvent; │   │
│  │   parseWebhookEvent(event: ProviderWebhookEvent): NormalizedWebhookEvent;   │   │
│  │ }                                                                            │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  Provider Implementations                                                           │
│  ├── StripeProvider (packages/billing-stripe)         ← Fase 1                      │
│  ├── MercadoPagoProvider (packages/billing-mercadopago) ← Fase 2+                   │
│  └── AsaasProvider (packages/billing-asaas)           ← Futuro                      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### Camadas de Dados (Provider-Agnóstico)

| Tabela Local | Conteúdo | Referência Provider |
|--------------|----------|---------------------|
| `billing_plan` | Regras de negócio, features, pricing | `provider_price_id` (polimórfico) |
| `tenant_subscription` | Estado, ciclo, overages | `provider_subscription_id`, `provider_customer_id` |
| `invoice` | Fatura, status, valores | `provider_invoice_id` |
| `payment` | Pagamento, status, método | `provider_payment_id`, `provider_charge_id` |
| `credit_grant` | Créditos concedidos | `provider_credit_note_id` |
| `provider_webhook_event` | Idempotência webhook | `provider_event_id`, `provider_name` |

---

## 2. Fluxo de Negócio (Sales-Led + Admin)

```
┌─────────────────┐     ┌──────────────────┐     ┌────────────────────┐     ┌─────────────────────┐
│  Vendas Comprova │────▶│  Admin Platform  │────▶│   Verifier Onboarding   │────▶│  Billing Ativo       │
│  Cadastra empresa│     │  Ativa Plano     │     │  Dados empresa + billing│     │  (Provider Subscription)│
│  (tenant tipo org)│     │  + Cria Provider │     │  (CNPJ, endereço,      │     │  Cobrança mensal    │
└─────────────────┘     └──────────────────┘     │   cartão, contato)    │     └─────────────────────┘
                                                 └────────────────────┘
```

### Responsabilidades

| Ator | Ação | Ferramenta |
|------|------|------------|
| **Vendas Comprova** | Cadastra tenant `type='organization'` + dados básicos | Admin Panel / API interna |
| **Admin Platform** | Cria/gerencia `billing_plan` → escolhe provider → sync automático | Admin Panel (CRUD Plans) |
| **Admin Platform** | Ativa billing no tenant: seleciona plano + provider → cria Subscription | Admin Panel (Tenants → Billing) |
| **Verifier (cliente)** | Completa onboarding: razão social, CNPJ, endereço, payment method, contato | Verifier Dashboard (onboarding flow) |
| **Sistema** | Webhook provider mantém `tenant_subscription` + `invoice` + `payment` sincronizados | Background workers |

---

## 3. Schema Updates (Provider-Agnóstico)

### 3.1 `billing_plan` — Admin CRUD + Provider Sync

```sql
-- Campos existentes no PR #84 + novos:
ALTER TABLE billing_plan ADD COLUMN IF NOT EXISTS provider_name text NOT NULL DEFAULT 'stripe'; -- 'stripe' | 'mercadopago' | 'asaas'
ALTER TABLE billing_plan ADD COLUMN IF NOT EXISTS provider_product_id text;
ALTER TABLE billing_plan ADD COLUMN IF NOT EXISTS provider_price_id text UNIQUE;
ALTER TABLE billing_plan ADD COLUMN IF NOT EXISTS interval text NOT NULL DEFAULT 'month'; -- 'month' | 'year'
ALTER TABLE billing_plan ADD COLUMN IF NOT EXISTS interval_count int NOT NULL DEFAULT 1;
ALTER TABLE billing_plan ADD COLUMN IF NOT EXISTS trial_period_days int DEFAULT 0;
ALTER TABLE billing_plan ADD COLUMN IF NOT EXISTS features jsonb DEFAULT '{}'; 
-- features: { validationsIncluded, overagePriceMicros, debitMode, currency, ... }
ALTER TABLE billing_plan ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE billing_plan ADD COLUMN IF NOT EXISTS created_by_admin_id uuid REFERENCES admin_user(id);

-- Constraint: provider_price_id único por provider
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_plan_provider_price 
  ON billing_plan (provider_name, provider_price_id);
```

### 3.2 `tenant_subscription` — Provider Fields

```sql
ALTER TABLE tenant_subscription ADD COLUMN IF NOT EXISTS provider_name text NOT NULL DEFAULT 'stripe';
ALTER TABLE tenant_subscription ADD COLUMN IF NOT EXISTS provider_customer_id text;
ALTER TABLE tenant_subscription ADD COLUMN IF NOT EXISTS provider_subscription_id text UNIQUE;
ALTER TABLE tenant_subscription ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'incomplete'; 
-- 'incomplete'|'trialing'|'active'|'past_due'|'canceled'|'unpaid'|'paused'
ALTER TABLE tenant_subscription ADD COLUMN IF NOT EXISTS current_period_start timestamptz;
ALTER TABLE tenant_subscription ADD COLUMN IF NOT EXISTS current_period_end timestamptz;
ALTER TABLE tenant_subscription ADD COLUMN IF NOT EXISTS trial_start timestamptz;
ALTER TABLE tenant_subscription ADD COLUMN IF NOT EXISTS trial_end timestamptz;
ALTER TABLE tenant_subscription ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean DEFAULT false;
ALTER TABLE tenant_subscription ADD COLUMN IF NOT EXISTS canceled_at timestamptz;
ALTER TABLE tenant_subscription ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE tenant_subscription ADD COLUMN IF NOT EXISTS payment_method_id text; -- default payment method
ALTER TABLE tenant_subscription ADD COLUMN IF NOT EXISTS billing_contact_email text;
ALTER TABLE tenant_subscription ADD COLUMN IF NOT EXISTS billing_company_name text;
ALTER TABLE tenant_subscription ADD COLUMN IF NOT EXISTS billing_cnpj text;
ALTER TABLE tenant_subscription ADD COLUMN IF NOT EXISTS billing_address jsonb;
ALTER TABLE tenant_subscription ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'; -- provider-specific extras
```

### 3.3 `invoice` + `payment` — Provider Sync

```sql
-- invoice
ALTER TABLE invoice ADD COLUMN IF NOT EXISTS provider_name text NOT NULL DEFAULT 'stripe';
ALTER TABLE invoice ADD COLUMN IF NOT EXISTS provider_invoice_id text UNIQUE;
ALTER TABLE invoice ADD COLUMN IF NOT EXISTS provider_invoice_pdf text; -- hosted URL
ALTER TABLE invoice ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft'; 
-- 'draft'|'open'|'paid'|'void'|'uncollectible'|'pending'

-- payment
ALTER TABLE payment ADD COLUMN IF NOT EXISTS provider_name text NOT NULL DEFAULT 'stripe';
ALTER TABLE payment ADD COLUMN IF NOT EXISTS provider_payment_id text UNIQUE; -- payment_intent / charge
ALTER TABLE payment ADD COLUMN IF NOT EXISTS provider_charge_id text; -- charge id (separado do PI)
ALTER TABLE payment ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending'; 
-- 'pending'|'succeeded'|'failed'|'refunded'|'partially_refunded'
ALTER TABLE payment ADD COLUMN IF NOT EXISTS payment_method_type text; -- 'card'|'boleto'|'pix'|'bank_transfer'
ALTER TABLE payment ADD COLUMN IF NOT EXISTS provider_fee_micros bigint; -- fee do gateway
```

### 3.4 `provider_webhook_event` — Idempotência Universal (Nova Tabela)

```sql
CREATE TABLE provider_webhook_event (
  id bigserial PRIMARY KEY,
  provider_name text NOT NULL, -- 'stripe' | 'mercadopago' | 'asaas'
  provider_event_id text NOT NULL, -- evt_xxx / webhook_id
  event_type text NOT NULL, -- 'subscription.created', 'invoice.paid', etc.
  payload jsonb NOT NULL,
  processed_at timestamptz,
  processing_error text,
  retry_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_name, provider_event_id)
);
CREATE INDEX idx_provider_webhook_event_created ON provider_webhook_event (created_at DESC);
CREATE INDEX idx_provider_webhook_event_unprocessed ON provider_webhook_event (provider_name, processed_at) 
  WHERE processed_at IS NULL;
```

---

## 4. Core Interfaces (packages/billing-core)

### 4.1 Provider Interface

```typescript
// packages/billing-core/src/provider.ts
export type Currency = 'BRL' | 'USD' | 'EUR';
export type Interval = 'month' | 'year';
export type SubscriptionStatus = 'incomplete' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';
export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible' | 'pending';
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'refunded' | 'partially_refunded';

export interface ProviderProduct {
  id: string;                    // provider-specific (prod_xxx)
  name: string;
  description?: string;
  metadata: Record<string, string>;
  active: boolean;
  createdAt: Date;
}

export interface ProviderPrice {
  id: string;                    // price_xxx
  productId: string;
  currency: Currency;
  unitAmountMicros: number;      // micros (1 BRL = 1_000_000)
  interval: Interval;
  intervalCount: number;
  trialPeriodDays?: number;
  metadata: Record<string, string>;
  active: boolean;
}

export interface ProviderCustomer {
  id: string;                    // cus_xxx
  email: string;
  name?: string;
  companyName?: string;
  taxId?: string;                // CNPJ/CPF
  address?: Address;
  defaultPaymentMethodId?: string;
  metadata: Record<string, string>;
  createdAt: Date;
}

export interface ProviderSubscription {
  id: string;                    // sub_xxx
  customerId: string;
  priceId: string;
  status: SubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialStart?: Date;
  trialEnd?: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt?: Date;
  pausedAt?: Date;
  defaultPaymentMethodId?: string;
  metadata: Record<string, string>;
  items: ProviderSubscriptionItem[];
}

export interface ProviderSubscriptionItem {
  id: string;                    // si_xxx
  priceId: string;
  quantity: number;
  usageType?: 'metered' | 'licensed';
}

export interface ProviderInvoice {
  id: string;                    // in_xxx
  subscriptionId?: string;
  customerId: string;
  status: InvoiceStatus;
  amountDueMicros: number;
  amountPaidMicros: number;
  currency: Currency;
  hostedInvoiceUrl?: string;
  invoicePdfUrl?: string;
  periodStart: Date;
  periodEnd: Date;
  dueDate?: Date;
  paidAt?: Date;
  lines: ProviderInvoiceLine[];
  metadata: Record<string, string>;
}

export interface ProviderInvoiceLine {
  id: string;
  priceId: string;
  quantity: number;
  amountMicros: number;
  description?: string;
  type: 'subscription' | 'usage' | 'credit' | 'proration';
  periodStart?: Date;
  periodEnd?: Date;
}

export interface ProviderPayment {
  id: string;                    // pi_xxx / ch_xxx
  invoiceId?: string;
  customerId: string;
  amountMicros: number;
  currency: Currency;
  status: PaymentStatus;
  paymentMethodType: string;     // 'card' | 'boleto' | 'pix' | 'bank_transfer'
  providerFeeMicros?: number;
  receiptUrl?: string;
  paidAt?: Date;
  refundedAt?: Date;
  metadata: Record<string, string>;
}

export interface ProviderCreditNote {
  id: string;                    // cn_xxx
  customerId: string;
  invoiceId?: string;
  amountMicros: number;
  currency: Currency;
  reason: 'duplicate' | 'fraudulent' | 'order_change' | 'product_unsatisfactory' | 'other';
  memo?: string;
  status: 'issued' | 'void';
  createdAt: Date;
}

export interface ProviderWebhookEvent {
  id: string;                    // evt_xxx
  type: string;                  // 'customer.subscription.updated', 'invoice.paid', etc.
  createdAt: Date;
  data: unknown;                 // raw provider object
  livemode: boolean;
}

export interface NormalizedWebhookEvent {
  type: WebhookEventType;
  providerSubscriptionId?: string;
  providerCustomerId?: string;
  providerInvoiceId?: string;
  providerPaymentId?: string;
  payload: unknown;
}

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
  | 'credit_note.created';

export interface BillingProvider {
  readonly name: string;
  readonly supportedCurrencies: Currency[];
  readonly supportedIntervals: Interval[];
  readonly supportedPaymentMethods: string[];

  // Products & Prices
  createProduct(input: CreateProductInput): Promise<ProviderProduct>;
  updateProduct(id: string, input: UpdateProductInput): Promise<void>;
  archiveProduct(id: string): Promise<void>;
  createPrice(productId: string, input: CreatePriceInput): Promise<ProviderPrice>;

  // Customers
  createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer>;
  updateCustomer(id: string, input: UpdateCustomerInput): Promise<void>;
  attachPaymentMethod(customerId: string, paymentMethodId: string): Promise<void>;
  detachPaymentMethod(customerId: string, paymentMethodId: string): Promise<void>;
  listPaymentMethods(customerId: string): Promise<ProviderPaymentMethod[]>;

  // Subscriptions
  createSubscription(input: CreateSubscriptionInput): Promise<ProviderSubscription>;
  updateSubscription(id: string, input: UpdateSubscriptionInput): Promise<void>;
  cancelSubscription(id: string, atPeriodEnd: boolean): Promise<void>;
  pauseSubscription(id: string): Promise<void>;
  resumeSubscription(id: string): Promise<void>;
  getSubscription(id: string): Promise<ProviderSubscription | null>;

  // Invoices & Payments
  createInvoice(input: CreateInvoiceInput): Promise<ProviderInvoice>;
  finalizeInvoice(id: string): Promise<void>;
  payInvoice(id: string, paymentMethodId?: string): Promise<ProviderPayment>;
  getInvoice(id: string): Promise<ProviderInvoice | null>;
  listInvoices(customerId: string, options?: ListInvoicesOptions): Promise<ProviderInvoice[]>;

  // Usage Metering
  reportUsage(subscriptionItemId: string, quantity: number, timestamp: number, action?: 'increment' | 'set'): Promise<void>;

  // Credits
  createCreditNote(input: CreateCreditNoteInput): Promise<ProviderCreditNote>;

  // Webhooks
  constructEvent(payload: string, signature: string): ProviderWebhookEvent;
  parseWebhookEvent(event: ProviderWebhookEvent): NormalizedWebhookEvent;
}
```

### 4.2 Domain Services (Provider-Agnostic)

```typescript
// packages/billing-core/src/plan.service.ts
export interface PlanFeatures {
  validationsIncluded: number;
  overagePriceMicros: number;
  debitMode: 'strict' | 'grace';        // strict: bloqueia; grace: fatura posterior
  currency: Currency;
  trialDays?: number;
  features: string[];                    // ['api_access', 'dashboard', 'webhooks', ...]
}

export class BillingPlanService {
  constructor(
    private db: Db,
    private providerRegistry: ProviderRegistry,
  ) {}

  async createPlan(input: CreatePlanInput): Promise<BillingPlan> {
    const provider = this.providerRegistry.get(input.providerName);
    const product = await provider.createProduct({ name: input.name, description: input.description });
    const price = await provider.createPrice(product.id, {
      currency: input.features.currency,
      unitAmountMicros: input.monthlyPriceMicros,
      interval: input.interval,
      intervalCount: input.intervalCount,
      trialPeriodDays: input.features.trialDays,
      metadata: { comprova_plan_id: 'pending' }, // atualiza após INSERT
    });

    return this.db.insert(billingPlan).values({
      name: input.name,
      description: input.description,
      providerName: input.providerName,
      providerProductId: product.id,
      providerPriceId: price.id,
      interval: input.interval,
      intervalCount: input.intervalCount,
      trialPeriodDays: input.features.trialDays,
      features: input.features,
      monthlyPriceMicros: input.monthlyPriceMicros,
      isActive: true,
      createdByAdminId: input.adminId,
    }).returning();
  }

  async updatePlan(planId: string, input: UpdatePlanInput): Promise<BillingPlan> {
    const plan = await this.getPlan(planId);
    const provider = this.providerRegistry.get(plan.providerName);

    if (input.name || input.description) {
      await provider.updateProduct(plan.providerProductId, {
        name: input.name,
        description: input.description,
      });
    }
    if (input.monthlyPriceMicros || input.interval) {
      // Stripe não permite alterar price; cria novo price e arquiva o antigo
      const newPrice = await provider.createPrice(plan.providerProductId, {
        currency: plan.features.currency,
        unitAmountMicros: input.monthlyPriceMicros ?? plan.monthlyPriceMicros,
        interval: input.interval ?? plan.interval,
        intervalCount: plan.intervalCount,
        metadata: { comprova_plan_id: planId },
      });
      await provider.archiveProduct(plan.providerPriceId); // ou archivePrice
      input.providerPriceId = newPrice.id;
    }

    return this.db.update(billingPlan).set(input).where(eq(billingPlan.id, planId)).returning();
  }

  async getPlanPricing(planId: string): Promise<PlanPricing> {
    const plan = await this.getPlan(planId);
    return {
      amountMicros: plan.monthlyPriceMicros / plan.features.validationsIncluded,
      debitMode: plan.features.debitMode ?? 'grace',
      validationsIncluded: plan.features.validationsIncluded,
      overagePriceMicros: plan.features.overagePriceMicros,
      currency: plan.features.currency,
      providerPriceId: plan.providerPriceId,
    };
  }
}
```

```typescript
// packages/billing-core/src/subscription.service.ts
export class SubscriptionService {
  constructor(
    private db: Db,
    private providerRegistry: ProviderRegistry,
    private planService: BillingPlanService,
    private customerService: CustomerService,
  ) {}

  async activateBilling(input: ActivateBillingInput): Promise<TenantSubscription> {
    const plan = await this.planService.getPlan(input.planId);
    const provider = this.providerRegistry.get(plan.providerName);

    // Garante customer no provider
    let customerId = input.tenantId; // buscar ou criar
    const customer = await this.customerService.ensureCustomer(input.tenantId, {
      email: input.billingContactEmail,
      companyName: input.billingCompanyName,
      taxId: input.billingCnpj,
      address: input.billingAddress,
    });
    customerId = customer.providerCustomerId;

    // Anexa payment method se fornecido
    if (input.paymentMethodId) {
      await provider.attachPaymentMethod(customerId, input.paymentMethodId);
    }

    // Cria subscription
    const subscription = await provider.createSubscription({
      customerId,
      priceId: plan.providerPriceId,
      trialDays: plan.features.trialDays ?? input.trialDays,
      defaultPaymentMethodId: input.paymentMethodId,
      metadata: { comprova_tenant_id: input.tenantId, comprova_plan_id: plan.id },
    });

    return this.db.insert(tenantSubscription).values({
      tenantId: input.tenantId,
      planId: input.planId,
      providerName: plan.providerName,
      providerCustomerId: customerId,
      providerSubscriptionId: subscription.id,
      status: subscription.status,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      trialStart: subscription.trialStart,
      trialEnd: subscription.trialEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      paymentMethodId: subscription.defaultPaymentMethodId,
      billingContactEmail: input.billingContactEmail,
      billingCompanyName: input.billingCompanyName,
      billingCnpj: input.billingCnpj,
      billingAddress: input.billingAddress,
    }).returning();
  }

  async handleWebhookEvent(normalized: NormalizedWebhookEvent): Promise<void> {
    switch (normalized.type) {
      case 'subscription.created':
      case 'subscription.updated':
        await this.syncSubscription(normalized.providerSubscriptionId!, normalized.providerName);
        break;
      case 'subscription.canceled':
        await this.cancelSubscription(normalized.providerSubscriptionId!, normalized.providerName);
        break;
      case 'invoice.paid':
        await this.syncInvoice(normalized.providerInvoiceId!, normalized.providerName);
        break;
      case 'payment_intent.succeeded':
        await this.syncPayment(normalized.providerPaymentId!, normalized.providerName);
        break;
      // ...
    }
  }
}
```

---

## 5. Provider Registry (Dependency Injection)

```typescript
// packages/billing-core/src/provider-registry.ts
export class ProviderRegistry {
  private providers = new Map<string, BillingProvider>();

  register(provider: BillingProvider): void {
    if (this.providers.has(provider.name)) {
      throw new Error(`Provider ${provider.name} already registered`);
    }
    this.providers.set(provider.name, provider);
  }

  get(name: string): BillingProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider ${name} not registered. Available: ${Array.from(this.providers.keys()).join(', ')}`);
    }
    return provider;
  }

  getByPlan(plan: BillingPlan): BillingProvider {
    return this.get(plan.providerName);
  }

  getBySubscription(sub: TenantSubscription): BillingProvider {
    return this.get(sub.providerName);
  }
}

// apps/api/src/app.ts (bootstrap)
const providerRegistry = new ProviderRegistry();
providerRegistry.register(new StripeProvider(stripeConfig));
providerRegistry.register(new MercadoPagoProvider(mpConfig));
// providerRegistry.register(new AsaasProvider(asaasConfig)); // futuro

const planService = new BillingPlanService(db, providerRegistry);
const subscriptionService = new SubscriptionService(db, providerRegistry, planService, customerService);
```

---

## 6. Stripe Provider Implementation (packages/billing-stripe)

```typescript
// packages/billing-stripe/src/stripe-provider.ts
export class StripeProvider implements BillingProvider {
  readonly name = 'stripe';
  readonly supportedCurrencies: Currency[] = ['BRL', 'USD', 'EUR'];
  readonly supportedIntervals: Interval[] = ['month', 'year'];
  readonly supportedPaymentMethods = ['card', 'boleto', 'pix', 'bank_transfer'];

  constructor(private stripe: Stripe, private config: StripeConfig) {}

  async createProduct(input: CreateProductInput): Promise<ProviderProduct> {
    const product = await this.stripe.products.create({
      name: input.name,
      description: input.description,
      metadata: input.metadata,
      active: true,
    }, { idempotencyKey: input.idempotencyKey });
    return this.mapProduct(product);
  }

  async createPrice(productId: string, input: CreatePriceInput): Promise<ProviderPrice> {
    const price = await this.stripe.prices.create({
      product: productId,
      currency: input.currency.toLowerCase(),
      unit_amount: input.unitAmountMicros / 10_000, // micros → centavos
      recurring: { interval: input.interval, interval_count: input.intervalCount },
      trial_period_days: input.trialPeriodDays,
      metadata: input.metadata,
    }, { idempotencyKey: input.idempotencyKey });
    return this.mapPrice(price);
  }

  async createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer> {
    const customer = await this.stripe.customers.create({
      email: input.email,
      name: input.name,
      company: input.companyName,
      tax_id: input.taxId,
      address: input.address ? this.mapAddress(input.address) : undefined,
      metadata: input.metadata,
    }, { idempotencyKey: input.idempotencyKey });
    return this.mapCustomer(customer);
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<ProviderSubscription> {
    const subscription = await this.stripe.subscriptions.create({
      customer: input.customerId,
      items: [{ price: input.priceId, quantity: input.quantity ?? 1 }],
      trial_period_days: input.trialDays,
      default_payment_method: input.defaultPaymentMethodId,
      payment_behavior: input.paymentMethodId ? 'default_incomplete' : 'allow_incomplete',
      expand: ['latest_invoice.payment_intent'],
      metadata: input.metadata,
    }, { idempotencyKey: input.idempotencyKey });
    return this.mapSubscription(subscription);
  }

  async reportUsage(subscriptionItemId: string, quantity: number, timestamp: number): Promise<void> {
    await this.stripe.subscriptionItems.createUsageRecord(subscriptionItemId, {
      quantity,
      timestamp,
      action: 'increment',
    }, { idempotencyKey: `usage-${subscriptionItemId}-${timestamp}` });
  }

  constructEvent(payload: string, signature: string): ProviderWebhookEvent {
    const event = this.stripe.webhooks.constructEvent(payload, signature, this.config.webhookSecret);
    return { id: event.id, type: event.type, createdAt: new Date(event.created * 1000), data: event.data.object, livemode: event.livemode };
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
      'payment_intent.succeeded': 'payment_intent.succeeded',
      'payment_intent.payment_failed': 'payment_intent.payment_failed',
      'payment_method.attached': 'payment_method.attached',
    };
    return {
      type: typeMap[event.type] ?? event.type,
      providerSubscriptionId: event.data.subscription ?? event.data.customer,
      providerCustomerId: event.data.customer,
      providerInvoiceId: event.data.id,
      providerPaymentId: event.data.payment_intent ?? event.data.charge,
      payload: event.data,
    };
  }

  // ... mappers privados (mapProduct, mapPrice, mapCustomer, mapSubscription, etc.)
}
```

---

## 7. HTTP Routes (Provider-Agnóstico)

### 7.1 Admin Routes (`/v1/admin/billing`)

```typescript
// POST /plans — Cria plano + provider price
{ "name": "Pro", "description": "...", "providerName": "stripe", "monthlyPriceMicros": 500000000, "interval": "month", "features": { "validationsIncluded": 1000, "overagePriceMicros": 600000, "debitMode": "grace", "currency": "BRL" } }

// PATCH /plans/:id — Atualiza (cria novo price se preço muda)

// POST /tenants/:tenantId/billing — Ativa billing (admin)
{ "planId": "plan_abc", "paymentMethodId": "pm_xxx", "trialDays": 14, "billingContactEmail": "billing@empresa.com", "billingCompanyName": "Empresa LTDA", "billingCnpj": "00.000.000/0001-00", "billingAddress": {...} }
```

### 7.2 Verifier Onboarding (`/v1/verifier/onboarding`)

```typescript
// GET /billing-setup — Retorna campos + client secret para setup_intent (salvar cartão)

// POST /billing-setup — Salva dados + payment_method
{ "companyName": "Empresa LTDA", "cnpj": "00.000.000/0001-00", "address": {...}, "paymentMethodId": "pm_xxx", "contactEmail": "billing@empresa.com" }

// POST /billing-setup/confirm — Admin confirma (opcional)
```

### 7.3 Webhook Unificado (`/v1/webhooks/:providerName`)

```typescript
// POST /webhooks/stripe
// POST /webhooks/mercadopago
// Valida signature → constrói evento normalizado → idempotência em provider_webhook_event → processa assíncrono
```

---

## 8. Fases de Entrega

### Fase 0 — Correções Base (1 semana)
- [ ] Fix wallet.ts replay bug (discriminar por `status`)
- [ ] Fix wallet_credit/reserve/release: double idempotency pós-lock
- [ ] Migration: return types corretos
- [ ] Testes concorrência

### Fase 1 — Core Abstraction + Stripe Provider (2 semanas)
- [ ] `packages/billing-core`: interfaces, ProviderRegistry, PlanService, SubscriptionService, CustomerService, InvoiceService
- [ ] `packages/billing-stripe`: StripeProvider implementation completa
- [ ] Migrations: `billing_plan.provider_name`, `provider_price_id`, `tenant_subscription.provider_*`, `invoice.provider_*`, `payment.provider_*`, `provider_webhook_event`
- [ ] Admin routes: CRUD Plans, Ativar billing
- [ ] Verifier onboarding: billing-setup
- [ ] Webhook unificado `/v1/webhooks/:providerName`

### Fase 2 — Fastpath Integration + Rating (1 semana)
- [ ] Pricing resolution via `PlanService.getPlanPricing()`
- [ ] Debit modes: `strict` | `grace` | `prepaid_only`
- [ ] Overages metered: `reportUsage()` no provider
- [ ] Fastpath retorna `billing { mode, amountMicros, providerSubscriptionItemId }`

### Fase 3 — Reconciliação + Observabilidade (1 semana)
- [ ] Job diário: sync subscriptions ativas vs provider
- [ ] Job diário: invoices open > 7d → alerta
- [ ] Job diário: usage_billing_unit vs provider invoice lines (metered)
- [ ] Métricas Prometheus, alertas Grafana, notificações email/Slack

### Fase 4 — Mercado Pago Provider (2 semanas, opcional)
- [ ] `packages/billing-mercadopago`: MercadoPagoProvider
- [ ] Preapproval (subscription) + Webhook handlers
- [ ] Pix/Boleto/Card support
- [ ] Compliance LGPD

---

## 9. Variáveis de Ambiente

```bash
# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PUBLISHABLE_KEY=pk_live_...

# Mercado Pago (futuro)
MERCADOPAGO_ACCESS_TOKEN=APP_USR-...
MERCADOPAGO_WEBHOOK_SECRET=...
MERCADOPAGO_PUBLIC_KEY=APP_USR-...

# App
BILLING_DEFAULT_PROVIDER=stripe
BILLING_DEFAULT_TRIAL_DAYS=14
BILLING_GRACE_PERIOD_DAYS=7
BILLING_OVERAGE_ALERT_THRESHOLD=0.8
STRIPE_API_VERSION=2024-06-20
```

---

## 10. Definition of Done

- [ ] Admin cria plano → provider price criado via interface unificada
- [ ] Admin ativa billing no tenant → subscription criada no provider escolhido
- [ ] Verifier onboarding salva payment_method → subscription `incomplete` → `active`
- [ ] Webhook provider normalizado → `provider_webhook_event` idempotente → sync local
- [ ] Fastpath usa `PlanPricing` do core → débito `strict/grace` → overages via `reportUsage()`
- [ ] Reconciliação diária: 0 discrepâncias entre uso local e provider
- [ ] Troca de provider no plano não quebra fluxo (apenas novo provider_price_id)
- [ ] `pnpm vitest run --project node` passa (testes unitários providers + integração)
- [ ] `pnpm typecheck` passa (12/12)

---

## 11. Próximos Passos Imediatos

```bash
git checkout -b feat/billing-provider-abstraction main

# Fase 0 (PR separado)
# fix(wallet): replay type discrimination + double idempotency

# Fase 1.1 - Packages structure
mkdir -p packages/billing-core/src packages/billing-stripe/src
# billing-core: provider.ts, provider-registry.ts, plan.service.ts, subscription.service.ts, customer.service.ts, invoice.service.ts
# billing-stripe: stripe-provider.ts, mappers.ts

# Fase 1.2 - Migrations
# billing_plan: provider_name, provider_product_id, provider_price_id, features, is_active
# tenant_subscription: provider_name, provider_customer_id, provider_subscription_id, billing_*
# invoice/payment: provider_name, provider_*_id
# provider_webhook_event: nova tabela

# Fase 1.3 - Admin Routes + Verifier Onboarding + Webhook
# POST /admin/billing/plans, PATCH /plans, POST /tenants/:id/billing
# GET/POST /verifier/onboarding/billing-setup
# POST /webhooks/:providerName
```

---

## 12. Benefícios da Abstração

| Cenário | Sem Abstração | Com Abstração |
|---------|---------------|---------------|
| Adicionar Mercado Pago | Refatoração profunda em routes, services, webhooks | Novo `MercadoPagoProvider` implementa interface |
| Trocar provider de um plano | Migração manual, código acoplado | `plan.providerName = 'mercadopago'` + novo price |
| Testes unitários | Mock de Stripe em todo lugar | Mock da interface `BillingProvider` |
| Compliance por país | If/else espalhados | Provider específico por região |
| Negociação comercial | Preso a um vendor | Multi-vendor, fallback, best price |