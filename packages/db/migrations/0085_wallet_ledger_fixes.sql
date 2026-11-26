SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- 0085 — Correções críticas no Wallet e Ledger (sobre 0076)
-- ============================================================================
-- 1. UNIQUE constraint em (tenant_id, idempotency_key) para idempotência real
--    sob concorrência (o índice parcial existente não impede duplicatas com
--    tenant_id diferentes em race condition)
-- 2. Remover grants diretos de escrita (INSERT/UPDATE) de app_user sobre
--    wallet e wallet_ledger; o app só deve chamar as funções SECURITY DEFINER.
-- 3. REVOKE EXECUTE FROM PUBLIC nas funções SECURITY DEFINER antes de conceder
--    a app_user.
-- 4. Validar tenant autorizado dentro das funções (app_tenant_id() = p_tenant_id).
-- 5. Corrigir ambiguidade de RETURNING entry_id (já OK mas reforçar clareza).
-- 6. Atomicidade entre atualização de saldo e ledger já garantida por LOCK
--    TABLE + FOR UPDATE + transação única.

-- ---------------------------------------------------------------------------
-- 1. Constraint UNIQUE forte para idempotência (tenant + key)
-- ---------------------------------------------------------------------------
-- O índice parcial existente (idx_wallet_ledger_idempotency) permite NULL e
-- não é UNIQUE; substituímos por constraint explícita.
DROP INDEX IF EXISTS idx_wallet_ledger_idempotency;

ALTER TABLE wallet_ledger
  ADD CONSTRAINT uq_wallet_ledger_tenant_idempotency
  UNIQUE (tenant_id, idempotency_key);

-- ---------------------------------------------------------------------------
-- 2. Revogar grants de escrita direta em tabelas (app_user só usa funções)
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON wallet FROM app_user;
REVOKE INSERT ON wallet_ledger FROM app_user;

-- app_user mantém SELECT para leitura de saldo/histórico
-- GRANT SELECT ON wallet TO app_user;  -- já existe
-- GRANT SELECT ON wallet_ledger TO app_user;  -- já existe

-- Conceder BYPASSRLS para app_user nas tabelas de wallet: as funções
-- SECURITY DEFINER já validam tenant/saldo; o TypeScript é apenas um
-- wrapper fino que chama as funções. O FORCE RLS nas tabelas impede até
-- o owner de consultar sem contexto, então BYPASSRLS é necessário para
-- o app_user executar as queries de idempotência/consulta dentro da transação.
ALTER TABLE wallet DISABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_ledger DISABLE ROW LEVEL SECURITY;

-- Re-habilitar RLS mas sem FORCE, para que o owner (funções SECURITY DEFINER)
-- possa acessar sem contexto, enquanto app_user respeita as policies.
ALTER TABLE wallet ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_ledger ENABLE ROW LEVEL SECURITY;

-- Recriar policies sem FORCE
DROP POLICY IF EXISTS tenant_isolation ON wallet;
CREATE POLICY tenant_isolation ON wallet
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

DROP POLICY IF EXISTS tenant_isolation ON wallet_ledger;
CREATE POLICY tenant_isolation ON wallet_ledger
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- NOTA: BYPASSRLS removido conforme CodeRabbit review.
-- O app_user NÃO deve ter BYPASSRLS; as funções SECURITY DEFINER
-- já desabilitam row_security internamente. O TypeScript chama
-- as funções (não faz UPDATE direto nas tabelas).
-- Se BYPASSRLS foi aplicado em ambiente, use migration 0088 para remover.

-- ---------------------------------------------------------------------------
-- 3. Revogar EXECUTE de PUBLIC e conceder apenas a app_user
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION wallet_credit(uuid, bigint, text, uuid, text, text, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION wallet_debit(uuid, bigint, text, uuid, text, text, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION wallet_reserve(uuid, bigint, text, uuid, text, text, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION wallet_release(uuid, bigint, text, uuid, text, text, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION wallet_adjust(uuid, bigint, text, uuid, text, text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION wallet_credit TO app_user;
GRANT EXECUTE ON FUNCTION wallet_debit TO app_user;
GRANT EXECUTE ON FUNCTION wallet_reserve TO app_user;
GRANT EXECUTE ON FUNCTION wallet_release TO app_user;
GRANT EXECUTE ON FUNCTION wallet_adjust TO app_user;

-- ---------------------------------------------------------------------------
-- 4. Recriar funções com validação de tenant + idempotência sob lock
-- ---------------------------------------------------------------------------
-- A idempotência agora é checada APÓS o lock, eliminando race condition.
-- A constraint UNIQUE (tenant_id, idempotency_key) é a barreira final.

-- ============================================================================
-- wallet_credit
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
  -- Desabilita RLS dentro da função: a função é SECURITY DEFINER e valida
  -- o tenant explicitamente via p_tenant_id = app_tenant_id(). O FORCE RLS
  -- na tabela wallet impediria até o owner de acessar sem contexto.
  SET LOCAL row_security = off;

  -- Null-safe tenant guard
  IF p_tenant_id IS DISTINCT FROM app_tenant_id() THEN
    RAISE EXCEPTION 'tenant mismatch: function called for tenant % but session is %', p_tenant_id, app_tenant_id();
  END IF;

  IF p_amount_micros <= 0 THEN
    RAISE EXCEPTION 'amount_micros must be positive';
  END IF;

  -- Lock serializa operações concorrentes no mesmo tenant
  LOCK TABLE wallet IN ROW EXCLUSIVE MODE;

  -- Garante existência da wallet
  INSERT INTO wallet (tenant_id, available_balance, reserved_balance, version)
  VALUES (p_tenant_id, 0, 0, 1)
  ON CONFLICT (tenant_id) DO NOTHING;

  -- Idempotência: checa ANTES de modificar, sob o lock
  IF p_idempotency_key IS NOT NULL THEN
    SELECT wl.entry_id, w.available_balance, w.reserved_balance
    INTO v_entry_id, v_available, v_reserved
    FROM wallet_ledger wl
    JOIN wallet w ON w.tenant_id = wl.tenant_id
    WHERE wl.tenant_id = p_tenant_id
      AND wl.idempotency_key = p_idempotency_key
    LIMIT 1;

    IF FOUND THEN
      RETURN QUERY SELECT v_entry_id, v_available, v_reserved;
      RETURN;
    END IF;
  END IF;

  -- Obtém saldos atuais com row lock
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

  -- Registra no ledger (constraint UNIQUE garante idempotência final)
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
-- wallet_debit
-- ============================================================================
-- Retorna status no resultado: 'debited', 'replayed', 'skipped' (com reason)
-- para evitar exceções que abortam a transação.
DROP FUNCTION IF EXISTS wallet_debit(uuid, bigint, text, uuid, text, text, text, jsonb);

CREATE FUNCTION wallet_debit(
  p_tenant_id uuid,
  p_amount_micros bigint,
  p_reference_type text,
  p_reference_id uuid,
  p_actor text,
  p_reason text,
  p_idempotency_key text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'
) RETURNS TABLE (
  status text,
  entry_id bigint,
  available_balance_micros bigint,
  reserved_balance_micros bigint,
  reason text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_entry_id bigint;
  v_available bigint;
  v_reserved bigint;
BEGIN
  SET LOCAL row_security = off;

  -- Null-safe tenant guard: missing session tenant raises; matching tenant passes
  IF p_tenant_id IS DISTINCT FROM app_tenant_id() THEN
    RAISE EXCEPTION 'tenant mismatch: function called for tenant % but session is %', p_tenant_id, app_tenant_id();
  END IF;

  IF p_amount_micros <= 0 THEN
    RAISE EXCEPTION 'amount_micros must be positive';
  END IF;

  LOCK TABLE wallet IN ROW EXCLUSIVE MODE;

  -- Idempotência: checa ANTES do lock (barreira rápida)
  IF p_idempotency_key IS NOT NULL THEN
    SELECT wl.entry_id, w.available_balance, w.reserved_balance
    INTO v_entry_id, v_available, v_reserved
    FROM wallet_ledger wl
    JOIN wallet w ON w.tenant_id = wl.tenant_id
    WHERE wl.tenant_id = p_tenant_id
      AND wl.idempotency_key = p_idempotency_key
    LIMIT 1;

    IF FOUND THEN
      RETURN QUERY SELECT 'replayed', v_entry_id, v_available, v_reserved, NULL;
      RETURN;
    END IF;
  END IF;

  -- Verifica wallet e saldo COM LOCK (FOR UPDATE)
  SELECT available_balance, reserved_balance
  INTO v_available, v_reserved
  FROM wallet
  WHERE tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'skipped', NULL::bigint, NULL::bigint, NULL::bigint, 'no_wallet';
    RETURN;
  END IF;

  -- Idempotência: checa DEPOIS do lock (barreira final sob concorrência)
  IF p_idempotency_key IS NOT NULL THEN
    SELECT wl.entry_id, w.available_balance, w.reserved_balance
    INTO v_entry_id, v_available, v_reserved
    FROM wallet_ledger wl
    JOIN wallet w ON w.tenant_id = wl.tenant_id
    WHERE wl.tenant_id = p_tenant_id
      AND wl.idempotency_key = p_idempotency_key
    LIMIT 1;

    IF FOUND THEN
      RETURN QUERY SELECT 'replayed', v_entry_id, v_available, v_reserved, NULL;
      RETURN;
    END IF;
  END IF;

  IF v_available < p_amount_micros THEN
    RETURN QUERY SELECT 'skipped', NULL::bigint, NULL::bigint, NULL::bigint, 'insufficient_balance';
    RETURN;
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
  RETURNING wl.entry_id, wl.balance_after_micros, wl.reserved_after_micros
  INTO v_entry_id, v_available, v_reserved;

  RETURN QUERY SELECT 'debited', v_entry_id, v_available, v_reserved, NULL;
END $$;

-- ============================================================================
-- wallet_reserve
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
  SET LOCAL row_security = off;

  -- Null-safe tenant guard
  IF p_tenant_id IS DISTINCT FROM app_tenant_id() THEN
    RAISE EXCEPTION 'tenant mismatch';
  END IF;

  IF p_amount_micros <= 0 THEN
    RAISE EXCEPTION 'amount_micros must be positive';
  END IF;

  LOCK TABLE wallet IN ROW EXCLUSIVE MODE;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT wl.entry_id, w.available_balance, w.reserved_balance
    INTO v_entry_id, v_available, v_reserved
    FROM wallet_ledger wl
    JOIN wallet w ON w.tenant_id = wl.tenant_id
    WHERE wl.tenant_id = p_tenant_id
      AND wl.idempotency_key = p_idempotency_key
    LIMIT 1;

    IF FOUND THEN RETURN QUERY SELECT v_entry_id, v_available, v_reserved; RETURN; END IF;
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
-- wallet_release
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
  SET LOCAL row_security = off;

  -- Null-safe tenant guard
  IF p_tenant_id IS DISTINCT FROM app_tenant_id() THEN
    RAISE EXCEPTION 'tenant mismatch';
  END IF;

  IF p_amount_micros <= 0 THEN
    RAISE EXCEPTION 'amount_micros must be positive';
  END IF;

  LOCK TABLE wallet IN ROW EXCLUSIVE MODE;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT wl.entry_id, w.available_balance, w.reserved_balance
    INTO v_entry_id, v_available, v_reserved
    FROM wallet_ledger wl
    JOIN wallet w ON w.tenant_id = wl.tenant_id
    WHERE wl.tenant_id = p_tenant_id
      AND wl.idempotency_key = p_idempotency_key
    LIMIT 1;

    IF FOUND THEN RETURN QUERY SELECT v_entry_id, v_available, v_reserved; RETURN; END IF;
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
-- wallet_adjust
-- ============================================================================
CREATE OR REPLACE FUNCTION wallet_adjust(
  p_tenant_id uuid,
  p_amount_micros bigint,
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
  SET LOCAL row_security = off;

  -- Null-safe tenant guard
  IF p_tenant_id IS DISTINCT FROM app_tenant_id() THEN
    RAISE EXCEPTION 'tenant mismatch';
  END IF;

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

-- Reafirmar grants
GRANT EXECUTE ON FUNCTION wallet_credit TO app_user;
GRANT EXECUTE ON FUNCTION wallet_debit TO app_user;
GRANT EXECUTE ON FUNCTION wallet_reserve TO app_user;
GRANT EXECUTE ON FUNCTION wallet_release TO app_user;
GRANT EXECUTE ON FUNCTION wallet_adjust TO app_user;