SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- 0086 — Correções críticas no Billing (sobre 0077)
-- ============================================================================
-- 1. Foreign keys preservam tenant: invoice.subscription_id já referencia
--    tenant_subscription que tem tenant_id; payment.invoice_id referencia
--    invoice que tem tenant_id. Adicionar FKs compostas para impor o tenant
--    no caminho invoice→subscription e payment→invoice.
-- 2. RLS invoice_item: WITH CHECK (false) impedia INSERT; corrigir para
--    permitir INSERT pelo app_user via tenant da invoice.
-- 3. create_subscription_invoice: argumentos de período incorretos ($1, $2
--    em vez de parâmetros nomeados); referências a variáveis inexistentes.
-- 4. Avaliação de limites opcionais quando max_* é NULL.
-- 5. Remover grants de escrita direta onde apropriado; app_user usa funções.

-- ---------------------------------------------------------------------------
-- 1. FKs compostas para preservar tenant no caminho invoice → subscription
-- ---------------------------------------------------------------------------
-- Primeiro: unique constraint em tenant_subscription para suportar FK composta
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'uq_tenant_subscription_sub_tenant'
  ) THEN
    ALTER TABLE tenant_subscription
      ADD CONSTRAINT uq_tenant_subscription_sub_tenant
      UNIQUE (subscription_id, tenant_id);
  END IF;
END $$;

-- invoice já tem tenant_id e subscription_id; garantir que a subscription
-- pertença ao mesmo tenant da invoice.
ALTER TABLE invoice
  DROP CONSTRAINT IF EXISTS invoice_subscription_id_fkey,
  ADD CONSTRAINT invoice_subscription_id_fkey
    FOREIGN KEY (subscription_id, tenant_id)
    REFERENCES tenant_subscription (subscription_id, tenant_id)
    ON DELETE SET NULL;

-- payment já tem tenant_id e invoice_id; garantir que a invoice pertença
-- ao mesmo tenant do payment.
-- invoice já tem PK invoice_id, mas precisamos de unique (invoice_id, tenant_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'uq_invoice_id_tenant'
  ) THEN
    ALTER TABLE invoice
      ADD CONSTRAINT uq_invoice_id_tenant
      UNIQUE (invoice_id, tenant_id);
  END IF;
END $$;

ALTER TABLE payment
  DROP CONSTRAINT IF EXISTS payment_invoice_id_fkey,
  ADD CONSTRAINT payment_invoice_id_fkey
    FOREIGN KEY (invoice_id, tenant_id)
    REFERENCES invoice (invoice_id, tenant_id)
    ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 2. RLS invoice_item: corrigir WITH CHECK para permitir INSERT
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_isolation ON invoice_item;

CREATE POLICY tenant_isolation ON invoice_item
  USING (invoice_id IN (SELECT invoice_id FROM invoice WHERE tenant_id = app_tenant_id()))
  WITH CHECK (invoice_id IN (SELECT invoice_id FROM invoice WHERE tenant_id = app_tenant_id()));

-- ---------------------------------------------------------------------------
-- 3. Recriar create_subscription_invoice com argumentos corretos
-- ---------------------------------------------------------------------------
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
  v_tenant_id uuid;
  v_currency text;
  v_due_at timestamptz;
BEGIN
  -- Busca assinatura com lock
  SELECT * INTO v_subscription
  FROM tenant_subscription
  WHERE subscription_id = p_subscription_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Subscription % not found', p_subscription_id;
  END IF;

  v_tenant_id := v_subscription.tenant_id;
  v_currency := v_subscription.currency;
  v_due_at := v_subscription.period_end + interval '15 days';

  -- Busca plano
  SELECT * INTO v_plan
  FROM billing_plan
  WHERE plan_id = v_subscription.plan_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Plan % not found', v_subscription.plan_id;
  END IF;

  -- Gera número
  SELECT generate_invoice_number(v_tenant_id) INTO v_number;

  -- Calcula itens
  v_subtotal := v_subscription.agreed_price_micros;
  v_items := jsonb_build_array(
    jsonb_build_object(
      'item_type', 'plan_base',
      'description', v_plan.name || ' - ' || to_char(p_period_start, 'MM/YYYY'),
      'quantity', 1,
      'unit_price_micros', v_subscription.agreed_price_micros,
      'total_micros', v_subscription.agreed_price_micros,
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
    v_tenant_id,
    p_subscription_id, v_number,
    'issued', p_period_start, p_period_end,
    v_subtotal, v_subtotal,
    v_currency, now(), v_due_at,
    v_items, now(), now()
  ) RETURNING invoice_id INTO v_invoice_id;

  -- Cria itens detalhados
  INSERT INTO invoice_item (invoice_id, item_type, description, quantity, unit_price_micros, total_micros, reference_type, reference_id)
  SELECT v_invoice_id, 'plan_base', v_plan.name || ' - ' || to_char(p_period_start, 'MM/YYYY'),
         1, v_subscription.agreed_price_micros, v_subscription.agreed_price_micros,
         'plan', p_subscription.plan_id;

  RETURN v_invoice_id;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Função auxiliar para avaliar limites (NULL = ilimitado)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION billing_check_limit(
  p_current_usage integer,
  p_max_limit integer DEFAULT NULL
) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_max_limit IS NULL OR p_current_usage < p_max_limit;
$$;

-- ---------------------------------------------------------------------------
-- 5. Revogar grants de escrita direta onde apropriado
--    app_user usa create_subscription_invoice; mantemos grants nas tabelas
--    de leitura/escrita necessárias para o fluxo, mas invoice_item INSERT
--    agora é permitido via RLS corrigido.
-- ---------------------------------------------------------------------------
-- Grants já existentes são adequados após correção do RLS.

-- Reafirmar grant da função corrigida
GRANT EXECUTE ON FUNCTION create_subscription_invoice(uuid, timestamptz, timestamptz, text) TO app_user;
GRANT EXECUTE ON FUNCTION generate_invoice_number(uuid) TO app_user;