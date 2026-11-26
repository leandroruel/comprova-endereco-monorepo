SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- F5.2 — Planos comerciais, assinaturas e faturas
-- ============================================================================
-- Planos definem limites, preços e regras de cobrança.
-- Assinaturas vinculam tenants a planos.
-- Faturas registram cobranças periódicas e avulsas.
-- ============================================================================

-- ============================================================================
-- Planos comerciais
-- ============================================================================
CREATE TABLE IF NOT EXISTS billing_plan (
  plan_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identificador legível (slug)
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  -- Modelo de cobrança
  billing_model text NOT NULL CHECK (billing_model IN ('prepaid', 'postpaid', 'hybrid')),
  -- Moeda (ISO 4217)
  currency text NOT NULL DEFAULT 'BRL',
  -- Preço base mensal (em micros)
  monthly_price_micros bigint NOT NULL DEFAULT 0,
  -- Inclusos no preço base
  included_validations integer NOT NULL DEFAULT 0,
  included_credentials integer NOT NULL DEFAULT 0,
  -- Preço por unidade adicional (em micros)
  price_per_validation_micros bigint NOT NULL DEFAULT 0,
  price_per_credential_micros bigint NOT NULL DEFAULT 0,
  -- Limites do plano
  max_validations_per_month integer,
  max_credentials_per_month integer,
  max_api_keys integer,
  max_webhooks integer,
  -- Features
  features jsonb NOT NULL DEFAULT '{}',
  -- Status
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deprecated')),
  -- Metadados
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_billing_plan_status ON billing_plan (status);

-- ============================================================================
-- Assinaturas de tenant
-- ============================================================================
CREATE TABLE IF NOT EXISTS tenant_subscription (
  subscription_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  plan_id uuid NOT NULL REFERENCES billing_plan (plan_id),
  -- Período da assinatura
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  -- Status
  status text NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'past_due', 'canceled', 'expired', 'trialing'
  )),
  -- Cobrança
  billing_cycle_anchor timestamptz NOT NULL, -- Quando o ciclo renova
  -- Preço acordado (pode diferir do plano base por descontos)
  agreed_price_micros bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'BRL',
  -- Uso no período atual
  validations_used integer NOT NULL DEFAULT 0,
  credentials_used integer NOT NULL DEFAULT 0,
  -- Trial
  trial_end timestamptz,
  -- Cancelamento
  canceled_at timestamptz,
  cancel_reason text,
  -- Metadados
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_tenant_subscription_tenant ON tenant_subscription (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_subscription_status ON tenant_subscription (status);
CREATE INDEX IF NOT EXISTS idx_tenant_subscription_period ON tenant_subscription (period_start, period_end);

-- ============================================================================
-- Faturas
-- ============================================================================
CREATE TABLE IF NOT EXISTS invoice (
  invoice_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  subscription_id uuid REFERENCES tenant_subscription (subscription_id),
  -- Número sequencial por tenant
  number text NOT NULL,
  -- Status
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'issued', 'paid', 'partially_paid', 'overdue', 'canceled', 'refunded'
  )),
  -- Período de referência
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  -- Valores (em micros)
  subtotal_micros bigint NOT NULL DEFAULT 0,
  discount_micros bigint NOT NULL DEFAULT 0,
  tax_micros bigint NOT NULL DEFAULT 0,
  total_micros bigint NOT NULL DEFAULT 0,
  paid_micros bigint NOT NULL DEFAULT 0,
  -- Moeda
  currency text NOT NULL DEFAULT 'BRL',
  -- Datas
  issued_at timestamptz,
  due_at timestamptz,
  paid_at timestamptz,
  -- Pagamento
  payment_method text,
  payment_reference text,
  paid_micros_total bigint NOT NULL DEFAULT 0,
  -- Cancelamento/estorno
  canceled_at timestamptz,
  canceled_reason text,
  refunded_micros bigint NOT NULL DEFAULT 0,
  -- Itens da fatura (JSONB para flexibilidade)
  items jsonb NOT NULL DEFAULT '[]',
  -- Metadados
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Número único por tenant
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_tenant_number
  ON invoice (tenant_id, number);

CREATE INDEX IF NOT EXISTS idx_invoice_tenant_status ON invoice (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_invoice_due ON invoice (due_at) WHERE status IN ('issued', 'partially_paid', 'overdue');
CREATE INDEX IF NOT EXISTS idx_invoice_subscription ON invoice (subscription_id);

-- ============================================================================
-- Itens de fatura (para relatórios detalhados)
-- ============================================================================
CREATE TABLE IF NOT EXISTS invoice_item (
  item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoice (invoice_id) ON DELETE CASCADE,
  -- Tipo do item
  item_type text NOT NULL CHECK (item_type IN (
    'plan_base',            -- Mensalidade do plano
    'validation_overage',   -- Validações excedentes
    'credential_overage',   -- Credenciais excedentes
    'validation_unit',      -- Validação avulsa
    'credential_unit',      -- Credencial avulsa
    'adjustment',           -- Ajuste/desconto
    'credit'                -- Crédito aplicado
  )),
  description text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  unit_price_micros bigint NOT NULL,
  total_micros bigint NOT NULL,
  -- Referência
  reference_type text,
  reference_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_item_invoice ON invoice_item (invoice_id);

-- ============================================================================
-- Pagamentos
-- ============================================================================
CREATE TABLE IF NOT EXISTS payment (
  payment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  invoice_id uuid REFERENCES invoice (invoice_id),
  -- Valor em micros
  amount_micros bigint NOT NULL CHECK (amount_micros > 0),
  currency text NOT NULL DEFAULT 'BRL',
  -- Status
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'succeeded', 'failed', 'refunded', 'canceled'
  )),
  -- Provider
  provider text NOT NULL, -- 'stripe', 'mercadopago', 'pix', 'manual', 'wallet'
  provider_payment_id text,
  provider_data jsonb NOT NULL DEFAULT '{}',
  -- Referência
  reference_type text,
  reference_id uuid,
  -- Idempotência
  idempotency_key text,
  -- Dados do pagamento
  method text, -- 'card', 'pix', 'boleto', 'bank_transfer', 'wallet'
  -- Metadados
  metadata jsonb NOT NULL DEFAULT '{}',
  -- Datas
  initiated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_idempotency
  ON payment (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_tenant_status ON payment (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_invoice ON payment (invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_provider ON payment (provider, provider_payment_id);

-- ============================================================================
-- Créditos promocionais / ajustes
-- ============================================================================
CREATE TABLE IF NOT EXISTS credit_grant (
  grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  -- Valor
  amount_micros bigint NOT NULL CHECK (amount_micros > 0),
  currency text NOT NULL DEFAULT 'BRL',
  -- Tipo
  grant_type text NOT NULL CHECK (grant_type IN (
    'promotional',      -- Promocional
    'referral',         -- Indicação
    'compensation',     -- Compensação/SLA
    'trial',            -- Trial
    'onboarding'        -- Boas-vindas
  )),
  -- Validade
  valid_from timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  -- Status
  status text NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'exhausted', 'expired', 'revoked'
  )),
  -- Uso
  used_micros bigint NOT NULL DEFAULT 0,
  -- Referência
  reference_type text,
  reference_id uuid,
  -- Metadados
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_grant_tenant_status ON credit_grant (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_credit_grant_expires ON credit_grant (expires_at) WHERE status = 'active';

-- ============================================================================
-- RLS - usando DO blocks para evitar erro de policy já existente
-- ============================================================================
DO $$
BEGIN
  ALTER TABLE billing_plan ENABLE ROW LEVEL SECURITY;
  ALTER TABLE billing_plan FORCE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  DROP POLICY IF EXISTS tenant_isolation ON billing_plan;
  CREATE POLICY tenant_isolation ON billing_plan
    USING (true)
    WITH CHECK (false);
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE tenant_subscription ENABLE ROW LEVEL SECURITY;
  ALTER TABLE tenant_subscription FORCE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  DROP POLICY IF EXISTS tenant_isolation ON tenant_subscription;
  CREATE POLICY tenant_isolation ON tenant_subscription
    USING (tenant_id = app_tenant_id())
    WITH CHECK (tenant_id = app_tenant_id());
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE invoice ENABLE ROW LEVEL SECURITY;
  ALTER TABLE invoice FORCE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  DROP POLICY IF EXISTS tenant_isolation ON invoice;
  CREATE POLICY tenant_isolation ON invoice
    USING (tenant_id = app_tenant_id())
    WITH CHECK (tenant_id = app_tenant_id());
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE invoice_item ENABLE ROW LEVEL SECURITY;
  ALTER TABLE invoice_item FORCE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  DROP POLICY IF EXISTS tenant_isolation ON invoice_item;
  CREATE POLICY tenant_isolation ON invoice_item
    USING (invoice_id IN (SELECT invoice_id FROM invoice WHERE tenant_id = app_tenant_id()))
    WITH CHECK (false);
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE payment ENABLE ROW LEVEL SECURITY;
  ALTER TABLE payment FORCE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  DROP POLICY IF EXISTS tenant_isolation ON payment;
  CREATE POLICY tenant_isolation ON payment
    USING (tenant_id = app_tenant_id())
    WITH CHECK (tenant_id = app_tenant_id());
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE credit_grant ENABLE ROW LEVEL SECURITY;
  ALTER TABLE credit_grant FORCE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  DROP POLICY IF EXISTS tenant_isolation ON credit_grant;
  CREATE POLICY tenant_isolation ON credit_grant
    USING (tenant_id = app_tenant_id())
    WITH CHECK (tenant_id = app_tenant_id());
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- ============================================================================
-- Grants
-- ============================================================================
GRANT SELECT ON billing_plan TO app_user;
GRANT SELECT, INSERT, UPDATE ON tenant_subscription TO app_user;
GRANT SELECT, INSERT, UPDATE ON invoice TO app_user;
GRANT SELECT, INSERT ON invoice_item TO app_user;
GRANT SELECT, INSERT, UPDATE ON payment TO app_user;
GRANT SELECT, INSERT, UPDATE ON credit_grant TO app_user;

-- ============================================================================
-- Função para gerar número de fatura sequencial por tenant
-- ============================================================================
CREATE OR REPLACE FUNCTION generate_invoice_number(p_tenant_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_next_num integer;
  v_number text;
BEGIN
  LOCK TABLE invoice IN EXCLUSIVE MODE;
  SELECT COALESCE(MAX(CAST(number AS integer)), 0) + 1
  INTO v_next_num
  FROM invoice
  WHERE tenant_id = p_tenant_id
    AND number ~ '^\d+$';
  v_number := v_next_num::text;
  RETURN v_number;
END $$;

-- ============================================================================
-- Função para criar fatura de assinatura
-- ============================================================================
DROP FUNCTION IF EXISTS create_subscription_invoice(uuid, timestamptz, timestamptz, text) CASCADE;

CREATE OR REPLACE FUNCTION create_subscription_invoice(
  p_subscription_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_actor text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_invoice_id uuid;
  v_subscription RECORD;
  v_plan RECORD;
  v_number text;
  v_subtotal bigint := 0;
  v_items jsonb := '[]';
BEGIN
  -- Busca assinatura com lock
  SELECT * INTO v_subscription
  FROM tenant_subscription
  WHERE subscription_id = p_subscription_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Subscription % not found', p_subscription_id;
  END IF;

  -- Busca plano
  SELECT * INTO v_plan
  FROM billing_plan
  WHERE plan_id = v_subscription.plan_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Plan % not found', v_subscription.plan_id;
  END IF;

  -- Gera número
  SELECT generate_invoice_number(v_subscription.tenant_id) INTO v_number;

  -- Calcula itens
  v_subtotal := v_subscription.agreed_price_micros;
  v_items := jsonb_build_array(
    jsonb_build_object(
      'item_type', 'plan_base',
      'description', v_plan.name || ' - ' || to_char(p_period_start, 'MM/YYYY'),
      'quantity', 1,
      'unit_price_micros', v_subscription.agreed_price_micros,
      'total_micros', v_subscription.agreed_price_micros,
      'item_type', 'plan_base',
      'reference_type', 'plan',
      'reference_id', v_subscription.plan_id
    )
  );

  -- Cria fatura
  INSERT INTO invoice (
    tenant_id, subscription_id, number,
    status, period_start, period_end,
    subtotal_micros, total_micros,
    currency, issued_at, due_at,
    items, created_at, updated_at
  ) VALUES (
    (SELECT tenant_id FROM tenant_subscription WHERE subscription_id = p_subscription_id),
    p_subscription_id, v_number,
    'issued', $1, $2,
    v_subtotal, v_subtotal,
    (SELECT currency FROM tenant_subscription WHERE subscription_id = p_subscription_id),
    now(), (SELECT period_end FROM tenant_subscription WHERE subscription_id = p_subscription_id) + interval '15 days',
    v_items, now(), now()
  ) RETURNING invoice_id INTO v_invoice_id;

  -- Cria itens detalhados
  INSERT INTO invoice_item (invoice_id, item_type, description, quantity, unit_price_micros, total_micros, reference_type, reference_id)
  SELECT v_invoice_id, 'plan_base', v_plan.name || ' - ' || to_char(p_period_start, 'MM/YYYY'),
         1, v_subscription.agreed_price_micros, v_subscription.agreed_price_micros,
         'plan', p_subscription.plan_id;

  RETURN v_invoice_id;
END $$;

-- ============================================================================
-- Grants para funções
-- ============================================================================
GRANT EXECUTE ON FUNCTION generate_invoice_number TO app_user;
GRANT EXECUTE ON FUNCTION create_subscription_invoice TO app_user;

-- ============================================================================
-- View para dashboard de billing
-- ============================================================================
CREATE OR REPLACE VIEW tenant_billing_summary AS
SELECT
  t.tenant_id,
  t.name AS tenant_name,
  w.available_balance,
  w.reserved_balance,
  (w.available_balance + w.reserved_balance) AS total_balance,
  ts.subscription_id,
  ts.status AS subscription_status,
  ts.period_start,
  ts.period_end,
  ts.validations_used,
  ts.credentials_used,
  bp.name AS plan_name,
  bp.billing_model,
  bp.monthly_price_micros,
  bp.included_validations,
  bp.included_credentials,
  bp.price_per_validation_micros,
  bp.price_per_credential_micros,
  ts.validations_used >= COALESCE(bp.max_validations_per_month, 0) AS validations_limit_reached,
  ts.credentials_used >= COALESCE(bp.max_credentials_per_month, 0) AS credentials_limit_reached
FROM tenant t
LEFT JOIN wallet w ON w.tenant_id = t.tenant_id
LEFT JOIN tenant_subscription ts ON ts.tenant_id = t.tenant_id AND ts.status IN ('active', 'trialing', 'past_due')
LEFT JOIN billing_plan bp ON bp.plan_id = ts.plan_id
WHERE t.status = 'active';