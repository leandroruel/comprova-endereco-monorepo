SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- F3.3 — Medição de uso, idempotência, cotas e reconciliação
--
-- Evolui `usage_event` de forma aditiva (compatível com registros históricos)
-- e cria tabelas de suporte para idempotência e auditoria de cotas.
-- ============================================================================

-- ============================================================================
-- 1. ALTER TABLE: adiciona colunas canônicas de uso em `usage_event` (aditivo,
--    compatível com registros históricos). Executado separadamente dos índices.
-- ============================================================================

-- Identificador de evento para referência estável (coluna sem PK, pois
-- `usage_event` é particionada e não aceita PK global sem a chave de partição).
ALTER TABLE usage_event
  ADD COLUMN IF NOT EXISTS event_id uuid;

ALTER TABLE usage_event
  ADD COLUMN IF NOT EXISTS event_type text NOT NULL DEFAULT 'technical_execution';

ALTER TABLE usage_event
  ADD COLUMN IF NOT EXISTS idempotency_key text;

ALTER TABLE usage_event
  ADD COLUMN IF NOT EXISTS billable boolean NOT NULL DEFAULT false;

ALTER TABLE usage_event
  ADD COLUMN IF NOT EXISTS source text;

-- ============================================================================
-- 2. Índices de suporte (não únicos: a unicidade global da chave de
--    idempotência é garantida pela tabela dedicada `usage_event_idempotency`,
--    não particionada — veja ADR-0044 item 2 e CodeRabbit o). Em tabela
--    particionada por `occurred_at`, um índice único não pode abranger colunas
--    fora da chave de partição, portanto não há `UNIQUE` aqui.
-- ============================================================================

-- Índice para consulta de consumo por tenant + período.
CREATE INDEX IF NOT EXISTS idx_usage_event_tenant_period
  ON usage_event (tenant_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_usage_event_billable
  ON usage_event (tenant_id, billable, occurred_at)
  WHERE billable = true;

-- Índice para lookup por validation_id.
CREATE INDEX IF NOT EXISTS idx_usage_event_validation
  ON usage_event (validation_id)
  WHERE validation_id IS NOT NULL;

-- Índice para lookup de idempotência.
CREATE INDEX IF NOT EXISTS idx_usage_event_idempotency
  ON usage_event (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ============================================================================
-- 3. Tabelas dedicadas (não particionadas).
-- ============================================================================

-- Tabela dedicada para idempotência global de eventos de uso, seguindo o
-- padrão de `validation_idempotency` (ADR-0004).
CREATE TABLE IF NOT EXISTS usage_event_idempotency (
  tenant_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key)
);

-- Auditoria de alterações de cota por tenant.
CREATE TABLE IF NOT EXISTS tenant_quota_audit (
  audit_id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  previous_quota bigint,
  new_quota bigint,
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text
);
CREATE INDEX IF NOT EXISTS idx_tenant_quota_audit_tenant ON tenant_quota_audit (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_quota_audit_changed_at ON tenant_quota_audit (changed_at);

-- ============================================================================
-- 4. Backfill: eventos de uso existentes que já referenciam uma validação
--    concluída são considerados faturáveis, para que a aplicação da cota hard
--    (F3.3) não redefina o consumo acumulado antes desta migration
--    (CodeRabbit p). Executado após a criação das colunas e índices.
-- ============================================================================

UPDATE usage_event
SET billable = true
WHERE validation_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM validation v
    WHERE v.validation_id = usage_event.validation_id
      AND v.tenant_id = usage_event.tenant_id
      AND v.status = 'completed'
  );

-- ============================================================================
-- 5. RLS nas novas tabelas (padrão existente: FORCE + app_tenant_id())
-- ============================================================================

ALTER TABLE usage_event_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_event_idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_event_idempotency
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE tenant_quota_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_quota_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_quota_audit
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- ============================================================================
-- 6. Grants
-- ============================================================================

GRANT SELECT, INSERT, UPDATE ON usage_event_idempotency TO app_user;
GRANT SELECT, INSERT ON tenant_quota_audit TO app_user;

-- usage_event já tem grants (0008_grants.sql). Reafirmar para as novas colunas.
GRANT SELECT, INSERT, UPDATE ON usage_event TO app_user;
