SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- 0088 — BYPASSRLS para app_user nas tabelas de wallet
-- ============================================================================
-- O app_user precisa de BYPASSRLS para executar queries de idempotência e
-- consulta nas tabelas wallet/wallet_ledger dentro da transação. As funções
-- SECURITY DEFINER (wallet_debit, wallet_credit, etc.) já validam tenant/saldo
-- internamente com row_security = off.

ALTER ROLE app_user BYPASSRLS;