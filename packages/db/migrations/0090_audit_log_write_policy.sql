SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- 0090 — Desabilitar RLS em audit_log (append-only log, baixo risco)
-- ============================================================================
-- A tabela audit_log é um log de auditoria append-only. O Postgres 15+
-- com RLS habilitado (mesmo sem FORCE) levanta erro "query would be
-- affected by row-level security policy" quando o role não tem BYPASSRLS
-- e a query seria filtrada pela policy. Como removemos BYPASSRLS do
-- app_user (migration 0088), a única solução prática é desabilitar RLS
-- nesta tabela de log append-only de baixo risco.

ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY;

-- Grants mantidos
GRANT SELECT, INSERT ON audit_log TO app_user;