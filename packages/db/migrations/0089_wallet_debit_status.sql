SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- 0089 — wallet_debit retorna status (substitui 0085 wallet_debit)
-- ============================================================================
-- A função wallet_debit agora retorna status ('debited', 'replayed', 'skipped')
-- em vez de lançar exceções que abortam a transação.
-- Inclui: null-safe tenant guard, idempotência dupla (antes/depois do lock),
-- NULL::bigint casting, table alias no RETURNING, revoke EXECUTE FROM PUBLIC.

DROP FUNCTION IF EXISTS public.wallet_debit(uuid, bigint, text, uuid, text, text, text, jsonb);

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

-- Revoke EXECUTE from PUBLIC (0089 recria a função, então revoga aqui também)
REVOKE EXECUTE ON FUNCTION public.wallet_debit(uuid, bigint, text, uuid, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wallet_debit(uuid, bigint, text, uuid, text, text, text, jsonb) TO app_user;