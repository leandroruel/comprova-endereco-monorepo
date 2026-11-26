SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- F5.1 — Wallet de créditos e Ledger imutável
-- ============================================================================
-- Cada tenant possui uma wallet de créditos com saldo disponível e reservado.
-- O ledger registra todas as movimentações financeiras de forma imutável.
-- Correções ocorrem apenas por novas transações compensatórias.
-- ============================================================================

-- Carteira de créditos do tenant
CREATE TABLE IF NOT EXISTS wallet (
  tenant_id uuid PRIMARY KEY REFERENCES tenant (tenant_id),
  -- Saldo disponível em micros (unidade mínima monetária, ex: centavos * 10000)
  available_balance bigint NOT NULL DEFAULT 0,
  -- Saldo reservado (operações pendentes, autorizações)
  reserved_balance bigint NOT NULL DEFAULT 0,
  -- Versão para controle de concorrência otimista
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Ledger imutável de movimentações financeiras
CREATE TABLE IF NOT EXISTS wallet_ledger (
  entry_id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  -- Tipo de movimentação
  entry_type text NOT NULL CHECK (entry_type IN (
    'credit',           -- Crédito recebido (pagamento, ajuste, estorno)
    'debit',            -- Débito por consumo (validação, emissão, etc.)
    'reservation',      -- Reserva de saldo (autorização pendente)
    'release',          -- Liberação de reserva
    'adjustment'        -- Ajuste administrativo
  )),
  -- Valor em micros (sempre positivo; o tipo define se é crédito ou débito)
  amount_micros bigint NOT NULL CHECK (amount_micros > 0),
  -- Saldo disponível APÓS esta movimentação
  balance_after_micros bigint NOT NULL,
  -- Saldo reservado APÓS esta movimentação
  reserved_after_micros bigint NOT NULL DEFAULT 0,
  -- Referência da operação que gerou a movimentação
  reference_type text CHECK (reference_type IN (
    'validation',       -- Validação de endereço
    'credential',       -- Emissão de credencial
    'payment',          -- Pagamento externo
    'adjustment',       -- Ajuste manual
    'refund',           -- Estorno
    'reservation',      -- Reserva de autorização
    'plan'              -- Compra/renovação de plano
  )),
  reference_id uuid,                    -- ID da validação, credencial, pagamento, etc.
  idempotency_key text,                 -- Chave de idempotência para operações idempotentes
  -- Quem/quando/porquê
  actor text NOT NULL,                  -- 'system', 'admin:<id>', 'user:<id>', 'webhook:<provider>'
  reason text,                          -- Justificativa legível
  metadata jsonb NOT NULL DEFAULT '{}', -- Dados adicionais estruturados
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Índices para consultas comuns
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_tenant_created
  ON wallet_ledger (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_tenant_type
  ON wallet_ledger (tenant_id, entry_type);

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_reference
  ON wallet_ledger (tenant_id, reference_type, reference_id);

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_idempotency
  ON wallet_ledger (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE wallet ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON wallet
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE wallet_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON wallet_ledger
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- ============================================================================
-- Grants
-- ============================================================================
GRANT SELECT, INSERT, UPDATE ON wallet TO app_user;
GRANT SELECT, INSERT ON wallet_ledger TO app_user;

-- ============================================================================
-- Função para credit (entrada de créditos)
-- ============================================================================
CREATE OR REPLACE FUNCTION wallet_credit(
  p_tenant_id uuid,
  p_amount_micros bigint,
  p_reference_type text,
  p_reference_id uuid,
  p_actor text,
  p_reason text,
  p_idempotency_key text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'
) RETURNS TABLE (
  entry_id bigint,
  available_balance_micros bigint,
  reserved_balance_micros bigint
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_entry_id bigint;
  v_available bigint;
  v_reserved bigint;
BEGIN
  IF p_amount_micros <= 0 THEN
    RAISE EXCEPTION 'amount_micros must be positive';
  END IF;

  -- Lock na wallet para concorrência
  LOCK TABLE wallet IN ROW EXCLUSIVE MODE;

  -- Obtém saldo atual ou cria wallet
  INSERT INTO wallet (tenant_id, available_balance, reserved_balance, version)
  VALUES (p_tenant_id, 0, 0, 1)
  ON CONFLICT (tenant_id) DO NOTHING;

  -- Verifica idempotência
  IF p_idempotency_key IS NOT NULL THEN
    RETURN QUERY
    SELECT wl.entry_id, w.available_balance, w.reserved_balance
    FROM wallet_ledger wl
    JOIN wallet w ON w.tenant_id = wl.tenant_id
    WHERE wl.tenant_id = p_tenant_id
      AND wl.idempotency_key = p_idempotency_key
    LIMIT 1;

    IF FOUND THEN
      RETURN;
    END IF;
  END IF;

  -- Obtém saldos atuais
  SELECT available_balance, reserved_balance
  INTO v_available, v_reserved
  FROM wallet
  WHERE tenant_id = p_tenant_id
  FOR UPDATE;

  v_available := v_available + p_amount_micros;

  -- Atualiza wallet
  UPDATE wallet
  SET available_balance = v_available,
      version = version + 1,
      updated_at = now()
  WHERE tenant_id = p_tenant_id;

  -- Registra no ledger
  INSERT INTO wallet_ledger (
    tenant_id, entry_type, amount_micros,
    balance_after_micros, reserved_after_micros,
    reference_type, reference_id,
    idempotency_key, actor, reason, metadata
  ) VALUES (
    p_tenant_id, 'credit', p_amount_micros,
    v_available, v_reserved,
    p_reference_type, p_reference_id,
    p_idempotency_key, p_actor, p_reason, COALESCE(p_metadata, '{}')
  )
  RETURNING entry_id, balance_after_micros, reserved_after_micros
  INTO v_entry_id, v_available, v_reserved;

  RETURN QUERY SELECT v_entry_id, v_available, v_reserved;
END $$;

-- ============================================================================
-- Função para debit (consumo de créditos)
-- ============================================================================
CREATE OR REPLACE FUNCTION wallet_debit(
  p_tenant_id uuid,
  p_amount_micros bigint,
  p_reference_type text,
  p_reference_id uuid,
  p_actor text,
  p_reason text,
  p_idempotency_key text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'
) RETURNS TABLE (
  entry_id bigint,
  available_balance_micros bigint,
  reserved_balance_micros bigint
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_entry_id bigint;
  v_available bigint;
  v_reserved bigint;
BEGIN
  IF p_amount_micros <= 0 THEN
    RAISE EXCEPTION 'amount_micros must be positive';
  END IF;

  LOCK TABLE wallet IN ROW EXCLUSIVE MODE;

  -- Verifica idempotência
  IF p_idempotency_key IS NOT NULL THEN
    RETURN QUERY
    SELECT wl.entry_id, w.available_balance, w.reserved_balance
    FROM wallet_ledger wl
    JOIN wallet w ON w.tenant_id = wl.tenant_id
    WHERE wl.tenant_id = p_tenant_id
      AND wl.idempotency_key = p_idempotency_key
    LIMIT 1;

    IF FOUND THEN
      RETURN;
    END IF;
  END IF;

  -- Obtém saldos atuais
  SELECT available_balance, reserved_balance
  INTO v_available, v_reserved
  FROM wallet
  WHERE tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found for tenant %', p_tenant_id;
  END IF;

  IF v_available < p_amount_micros THEN
    RAISE EXCEPTION 'Insufficient balance: available % < required %', v_available, p_amount_micros;
  END IF;

  v_available := v_available - p_amount_micros;

  UPDATE wallet
  SET available_balance = v_available,
      version = version + 1,
      updated_at = now()
  WHERE tenant_id = p_tenant_id;

  INSERT INTO wallet_ledger (
    tenant_id, entry_type, amount_micros,
    balance_after_micros, reserved_after_micros,
    reference_type, reference_id,
    idempotency_key, actor, reason, metadata
  ) VALUES (
    p_tenant_id, 'debit', p_amount_micros,
    v_available, v_reserved,
    p_reference_type, p_reference_id,
    p_idempotency_key, p_actor, p_reason, COALESCE(p_metadata, '{}')
  )
  RETURNING entry_id, balance_after_micros, reserved_after_micros
  INTO v_entry_id, v_available, v_reserved;

  RETURN QUERY SELECT v_entry_id, v_available, v_reserved;
END $$;

-- ============================================================================
-- Função para reservar saldo (autorização pendente)
-- ============================================================================
CREATE OR REPLACE FUNCTION wallet_reserve(
  p_tenant_id uuid,
  p_amount_micros bigint,
  p_reference_type text,
  p_reference_id uuid,
  p_actor text,
  p_reason text,
  p_idempotency_key text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'
) RETURNS TABLE (
  entry_id bigint,
  available_balance_micros bigint,
  reserved_balance_micros bigint
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_entry_id bigint;
  v_available bigint;
  v_reserved bigint;
BEGIN
  IF p_amount_micros <= 0 THEN
    RAISE EXCEPTION 'amount_micros must be positive';
  END IF;

  LOCK TABLE wallet IN ROW EXCLUSIVE MODE;

  IF p_idempotency_key IS NOT NULL THEN
    RETURN QUERY
    SELECT wl.entry_id, w.available_balance, w.reserved_balance
    FROM wallet_ledger wl
    JOIN wallet w ON w.tenant_id = wl.tenant_id
    WHERE wl.tenant_id = p_tenant_id
      AND wl.idempotency_key = p_idempotency_key
    LIMIT 1;

    IF FOUND THEN RETURN; END IF;
  END IF;

  SELECT available_balance, reserved_balance
  INTO v_available, v_reserved
  FROM wallet
  WHERE tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found for tenant %', p_tenant_id;
  END IF;

  IF v_available < p_amount_micros THEN
    RAISE EXCEPTION 'Insufficient available balance for reservation: % < %', v_available, p_amount_micros;
  END IF;

  v_available := v_available - p_amount_micros;
  v_reserved := v_reserved + p_amount_micros;

  UPDATE wallet
  SET available_balance = v_available,
      reserved_balance = v_reserved,
      version = version + 1,
      updated_at = now()
  WHERE tenant_id = p_tenant_id;

  INSERT INTO wallet_ledger (
    tenant_id, entry_type, amount_micros,
    balance_after_micros, reserved_after_micros,
    reference_type, reference_id,
    idempotency_key, actor, reason, metadata
  ) VALUES (
    p_tenant_id, 'reservation', p_amount_micros,
    v_available, v_reserved,
    p_reference_type, p_reference_id,
    p_idempotency_key, p_actor, p_reason, COALESCE(p_metadata, '{}')
  )
  RETURNING entry_id, balance_after_micros, reserved_after_micros
  INTO v_entry_id, v_available, v_reserved;

  RETURN QUERY SELECT v_entry_id, v_available, v_reserved;
END $$;

-- ============================================================================
-- Função para liberar reserva
-- ============================================================================
CREATE OR REPLACE FUNCTION wallet_release(
  p_tenant_id uuid,
  p_amount_micros bigint,
  p_reference_type text,
  p_reference_id uuid,
  p_actor text,
  p_reason text,
  p_idempotency_key text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'
) RETURNS TABLE (
  entry_id bigint,
  available_balance_micros bigint,
  reserved_balance_micros bigint
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_entry_id bigint;
  v_available bigint;
  v_reserved bigint;
BEGIN
  IF p_amount_micros <= 0 THEN
    RAISE EXCEPTION 'amount_micros must be positive';
  END IF;

  LOCK TABLE wallet IN ROW EXCLUSIVE MODE;

  IF p_idempotency_key IS NOT NULL THEN
    RETURN QUERY
    SELECT wl.entry_id, w.available_balance, w.reserved_balance
    FROM wallet_ledger wl
    JOIN wallet w ON w.tenant_id = wl.tenant_id
    WHERE wl.tenant_id = p_tenant_id
      AND wl.idempotency_key = p_idempotency_key
    LIMIT 1;

    IF FOUND THEN RETURN; END IF;
  END IF;

  SELECT available_balance, reserved_balance
  INTO v_available, v_reserved
  FROM wallet
  WHERE tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found for tenant %', p_tenant_id;
  END IF;

  IF v_reserved < p_amount_micros THEN
    RAISE EXCEPTION 'Insufficient reserved balance: % < %', v_reserved, p_amount_micros;
  END IF;

  v_available := v_available + p_amount_micros;
  v_reserved := v_reserved - p_amount_micros;

  UPDATE wallet
  SET available_balance = v_available,
      reserved_balance = v_reserved,
      version = version + 1,
      updated_at = now()
  WHERE tenant_id = p_tenant_id;

  INSERT INTO wallet_ledger (
    tenant_id, entry_type, amount_micros,
    balance_after_micros, reserved_after_micros,
    reference_type, reference_id,
    idempotency_key, actor, reason, metadata
  ) VALUES (
    p_tenant_id, 'release', p_amount_micros,
    v_available, v_reserved,
    p_reference_type, p_reference_id,
    p_idempotency_key, p_actor, p_reason, COALESCE(p_metadata, '{}')
  )
  RETURNING entry_id, balance_after_micros, reserved_after_micros
  INTO v_entry_id, v_available, v_reserved;

  RETURN QUERY SELECT v_entry_id, v_available, v_reserved;
END $$;

-- ============================================================================
-- Função para ajuste administrativo
-- ============================================================================
CREATE OR REPLACE FUNCTION wallet_adjust(
  p_tenant_id uuid,
  p_amount_micros bigint,  -- pode ser negativo (débito) ou positivo (crédito)
  p_reference_type text,
  p_reference_id uuid,
  p_actor text,
  p_reason text,
  p_metadata jsonb DEFAULT '{}'
) RETURNS TABLE (
  entry_id bigint,
  available_balance_micros bigint,
  reserved_balance_micros bigint
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_entry_id bigint;
  v_available bigint;
  v_reserved bigint;
  v_entry_type text;
BEGIN
  IF p_amount_micros = 0 THEN
    RAISE EXCEPTION 'amount_micros cannot be zero';
  END IF;

  LOCK TABLE wallet IN ROW EXCLUSIVE MODE;

  SELECT available_balance, reserved_balance
  INTO v_available, v_reserved
  FROM wallet
  WHERE tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found for tenant %', p_tenant_id;
  END IF;

  IF p_amount_micros > 0 THEN
    v_available := v_available + p_amount_micros;
    v_entry_type := 'adjustment';
  ELSE
    IF v_available < abs(p_amount_micros) THEN
      RAISE EXCEPTION 'Insufficient balance for negative adjustment';
    END IF;
    v_available := v_available - abs(p_amount_micros);
    v_entry_type := 'adjustment';
  END IF;

  UPDATE wallet
  SET available_balance = v_available,
      version = version + 1,
      updated_at = now()
  WHERE tenant_id = p_tenant_id;

  INSERT INTO wallet_ledger (
    tenant_id, entry_type, amount_micros,
    balance_after_micros, reserved_after_micros,
    reference_type, reference_id,
    actor, reason, metadata
  ) VALUES (
    p_tenant_id, v_entry_type, abs(p_amount_micros),
    v_available, v_reserved,
    p_reference_type, p_reference_id,
    p_actor, p_reason, COALESCE(p_metadata, '{}')
  )
  RETURNING entry_id, balance_after_micros, reserved_after_micros
  INTO v_entry_id, v_available, v_reserved;

  RETURN QUERY SELECT v_entry_id, v_available, v_reserved;
END $$;

-- ============================================================================
-- View para consulta de saldo
-- ============================================================================
CREATE OR REPLACE VIEW wallet_balance AS
SELECT
  w.tenant_id,
  w.available_balance,
  w.reserved_balance,
  (w.available_balance + w.reserved_balance) AS total_balance,
  w.version,
  w.updated_at
FROM wallet w;

-- ============================================================================
-- Grants para as funções
-- ============================================================================
GRANT EXECUTE ON FUNCTION wallet_credit TO app_user;
GRANT EXECUTE ON FUNCTION wallet_debit TO app_user;
GRANT EXECUTE ON FUNCTION wallet_reserve TO app_user;
GRANT EXECUTE ON FUNCTION wallet_release TO app_user;
GRANT EXECUTE ON FUNCTION wallet_adjust TO app_user;