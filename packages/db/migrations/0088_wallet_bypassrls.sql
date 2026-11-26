SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- 0088 — Remover BYPASSRLS de app_user (conforme CodeRabbit review)
-- ============================================================================
-- A migration 0085 concedeu BYPASSRLS ao app_user, mas as funções
-- SECURITY DEFINER já desabilitam row_security internamente.
-- O TypeScript chama as funções (não faz UPDATE direto nas tabelas).
-- Esta migration remove o BYPASSRLS para manter o princípio de menor privilégio.

ALTER ROLE app_user NOBYPASSRLS;