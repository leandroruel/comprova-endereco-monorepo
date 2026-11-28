SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- 0094 — Billing Provider Abstraction Layer
-- ============================================================================
-- Adiciona campos para suportar múltiplos providers de pagamento (Stripe,
-- Mercado Pago, Asaas, etc.) nas tabelas de billing existentes.
-- Mantém compatibilidade com dados existentes (defaults para 'stripe').

-- ---------------------------------------------------------------------------
-- billing_plan — provider fields + features JSON
-- ---------------------------------------------------------------------------
ALTER TABLE billing_plan
  ADD COLUMN IF NOT EXISTS provider_name text NOT NULL DEFAULT 'stripe',
  ADD COLUMN IF NOT EXISTS provider_product_id text,
  ADD COLUMN IF NOT EXISTS provider_price_id text,
  ADD COLUMN IF NOT EXISTS interval text NOT NULL DEFAULT 'month',
  ADD COLUMN IF NOT EXISTS interval_count int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS trial_period_days int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_by_admin_id text REFERENCES admin_user(id);

-- Constraint: provider_price_id único por provider
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_plan_provider_price
  ON billing_plan (provider_name, provider_price_id);

-- Index para consultas ativas
CREATE INDEX IF NOT EXISTS idx_billing_plan_active_provider
  ON billing_plan (is_active, provider_name);

-- ---------------------------------------------------------------------------
-- tenant_subscription — provider fields + billing info
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_subscription
  ADD COLUMN IF NOT EXISTS provider_name text NOT NULL DEFAULT 'stripe',
  ADD COLUMN IF NOT EXISTS provider_customer_id text,
  ADD COLUMN IF NOT EXISTS provider_subscription_id text UNIQUE,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'incomplete',
  ADD COLUMN IF NOT EXISTS current_period_start timestamptz,
  ADD COLUMN IF NOT EXISTS current_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS trial_start timestamptz,
  ADD COLUMN IF NOT EXISTS trial_end timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS canceled_at timestamptz,
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_method_id text,
  ADD COLUMN IF NOT EXISTS billing_contact_email text,
  ADD COLUMN IF NOT EXISTS billing_company_name text,
  ADD COLUMN IF NOT EXISTS billing_cnpj text,
  ADD COLUMN IF NOT EXISTS billing_address jsonb,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';

-- Constraint: status válido
ALTER TABLE tenant_subscription
  DROP CONSTRAINT IF EXISTS tenant_subscription_status_check;
ALTER TABLE tenant_subscription
  ADD CONSTRAINT tenant_subscription_status_check
  CHECK (status IN ('incomplete', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused', 'incomplete_expired'));

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tenant_subscription_tenant_provider
  ON tenant_subscription (tenant_id, provider_name);
CREATE INDEX IF NOT EXISTS idx_tenant_subscription_provider_sub
  ON tenant_subscription (provider_name, provider_subscription_id);
CREATE INDEX IF NOT EXISTS idx_tenant_subscription_status
  ON tenant_subscription (status) WHERE status IN ('active', 'trialing', 'past_due');

-- ---------------------------------------------------------------------------
-- invoice — provider fields
-- ---------------------------------------------------------------------------
ALTER TABLE invoice
  ADD COLUMN IF NOT EXISTS provider_name text NOT NULL DEFAULT 'stripe',
  ADD COLUMN IF NOT EXISTS provider_invoice_id text UNIQUE,
  ADD COLUMN IF NOT EXISTS provider_invoice_pdf text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS amount_due_micros bigint,
  ADD COLUMN IF NOT EXISTS amount_paid_micros bigint,
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS hosted_invoice_url text,
  ADD COLUMN IF NOT EXISTS invoice_pdf_url text,
  ADD COLUMN IF NOT EXISTS period_start timestamptz,
  ADD COLUMN IF NOT EXISTS period_end timestamptz,
  ADD COLUMN IF NOT EXISTS due_date timestamptz,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;

-- Constraint: status válido
ALTER TABLE invoice
  DROP CONSTRAINT IF EXISTS invoice_status_check;
ALTER TABLE invoice
  ADD CONSTRAINT invoice_status_check
  CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible', 'pending'));

-- Indexes
CREATE INDEX IF NOT EXISTS idx_invoice_provider
  ON invoice (provider_name, provider_invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_subscription_status
  ON invoice (subscription_id, status);

-- ---------------------------------------------------------------------------
-- payment — provider fields
-- ---------------------------------------------------------------------------
ALTER TABLE payment
  ADD COLUMN IF NOT EXISTS provider_name text NOT NULL DEFAULT 'stripe',
  ADD COLUMN IF NOT EXISTS provider_payment_id text UNIQUE,
  ADD COLUMN IF NOT EXISTS provider_charge_id text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS amount_micros bigint,
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS payment_method_type text,
  ADD COLUMN IF NOT EXISTS provider_fee_micros bigint,
  ADD COLUMN IF NOT EXISTS receipt_url text,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

-- Constraint: status válido
ALTER TABLE payment
  DROP CONSTRAINT IF EXISTS payment_status_check;
ALTER TABLE payment
  ADD CONSTRAINT payment_status_check
  CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded'));

-- Indexes
CREATE INDEX IF NOT EXISTS idx_payment_provider
  ON payment (provider_name, provider_payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_invoice_status
  ON payment (invoice_id, status);

-- ---------------------------------------------------------------------------
-- provider_webhook_event — idempotência universal (nova tabela)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_webhook_event (
  id bigserial PRIMARY KEY,
  provider_name text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  processed_at timestamptz,
  processing_error text,
  retry_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_name, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_webhook_event_created
  ON provider_webhook_event (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_webhook_event_unprocessed
  ON provider_webhook_event (provider_name, processed_at)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- tenant — provider fields (para customer/payment method)
-- ---------------------------------------------------------------------------
ALTER TABLE tenant
  ADD COLUMN IF NOT EXISTS provider_name text,
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_payment_method_id text;

-- Index
CREATE INDEX IF NOT EXISTS idx_tenant_provider_customer
  ON tenant (provider_name, stripe_customer_id);

-- ---------------------------------------------------------------------------
-- Grants para app_user
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON billing_plan TO app_user;
GRANT SELECT, INSERT, UPDATE ON tenant_subscription TO app_user;
GRANT SELECT, INSERT, UPDATE ON invoice TO app_user;
GRANT SELECT, INSERT, UPDATE ON payment TO app_user;
GRANT SELECT, INSERT ON provider_webhook_event TO app_user;