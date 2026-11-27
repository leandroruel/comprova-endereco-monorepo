SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- 0093 — Restaurar RLS em audit_log (reverte 0090)
-- ============================================================================
-- A migration 0090 desabilitou RLS em audit_log porque as funções de wallet
-- usavam SET LOCAL row_security = off, o que vazava o bypass para o
-- audit_log inserido na mesma transação.
-- 
-- A correção remove SET LOCAL row_security = off das funções de wallet
-- (migration 0085, wallet.ts) e restaura o RLS aqui com a policy original
-- de isolamento por tenant (tenant_id IS NULL para eventos de sistema).

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- Policy original: eventos de sistema (tenant_id IS NULL) são visíveis a
-- todos os tenants; eventos de tenant só visíveis ao próprio tenant.
DROP POLICY IF EXISTS tenant_isolation ON audit_log;
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id IS NULL OR tenant_id = app_tenant_id())
  WITH CHECK (tenant_id IS NULL OR tenant_id = app_tenant_id());

-- Grants mantidos
GRANT SELECT, INSERT ON audit_log TO app_user;
