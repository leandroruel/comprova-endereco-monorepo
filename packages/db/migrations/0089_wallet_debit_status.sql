SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- 0089 — Apenas grants (função já criada em 0085 com return type correto)
-- ============================================================================
-- A função wallet_debit já foi criada corretamente na migration 0085 com:
-- - Null-safe tenant guard
-- - Idempotência dupla (antes e depois do lock)
-- - NULL::bigint casting para branches 'skipped'
-- - Table alias no RETURNING (wl.entry_id)
-- - Status-based return ('debited', 'replayed', 'skipped')
-- - Revoke EXECUTE FROM PUBLIC

-- Revoke EXECUTE from PUBLIC (0085 cria a função, então revoga aqui também)
REVOKE EXECUTE ON FUNCTION public.wallet_debit(uuid, bigint, text, uuid, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wallet_debit(uuid, bigint, text, uuid, text, text, text, jsonb) TO app_user;