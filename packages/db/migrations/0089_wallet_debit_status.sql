SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- 0089 — wallet_debit retorna JSON com status (mantém assinatura compatível)
-- ============================================================================
-- A função wallet_debit agora retorna JSON com status para evitar exceções
-- que abortam a transação. Mantém a mesma assinatura para compatibilidade
-- com código existente que espera (entry_id, available, reserved).

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
  entry_id bigint,
  available_balance_micros bigint,
  reserved_balance_micros bigint,
  status text,
  reason text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_entry_id bigint;
  v_available bigint;
  v_reserved bigint;
BEGIN
  SET LOCAL row_security = off;

  IF p_tenant_id <> app_tenant_id() THEN
    RAISE EXCEPTION 'tenant mismatch: function called for tenant % but session is %', p_tenant_id, app_tenant_id();
  END IF;

  IF p_amount_micros <= 0 THEN
    RAISE EXCEPTION 'amount_micros must be positive';
  END IF;

  LOCK TABLE wallet IN ROW EXCLUSIVE MODE;

  -- Idempotência
  IF p_idempotency_key IS NOT NULL THEN
    SELECT wl.entry_id, w.available_balance, w.reserved_balance
    INTO v_entry_id, v_available, v_reserved
    FROM wallet_ledger wl
    JOIN wallet w ON w.tenant_id = wl.tenant_id
    WHERE wl.tenant_id = p_tenant_id
      AND wl.idempotency_key = p_idempotency_key
    LIMIT 1;

    IF FOUND THEN
      RETURN QUERY SELECT v_entry_id, v_available, v_reserved, 'replayed', NULL;
      RETURN;
    END IF;
  END IF;

  -- Verifica wallet e saldo
  SELECT available_balance, reserved_balance
  INTO v_available, v_reserved
  FROM wallet
  WHERE tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL, NULL, NULL, 'skipped', 'no_wallet';
    RETURN;
  END IF;

  IF v_available < p_amount_micros THEN
    RETURN QUERY SELECT NULL, NULL, NULL, 'skipped', 'insufficient_balance';
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
  RETURNING entry_id, balance_after_micros, reserved_after_micros
  INTO v_entry_id, v_available, v_reserved;

  RETURN QUERY SELECT v_entry_id, v_available, v_reserved, 'debited', NULL;
END $$;

GRANT EXECUTE ON FUNCTION wallet_debit TO app_user;