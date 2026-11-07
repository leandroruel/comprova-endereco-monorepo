SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- F3.3 — Status de bloqueio por quota hard (blocked_quota)
--
-- Adiciona o valor `blocked_quota` ao enum `val_status` e um campo
-- `quota_blocked_reason` na tabela `validation`, para que o deep worker
-- possa persistir um estado de negócio explícito quando o processamento
-- é bloqueado por cota hard, em vez de deixar a validação presa em `queued`
-- após o rollback da transação de uso.
-- ============================================================================

-- Adiciona o novo valor ao enum val_status.
ALTER TYPE val_status ADD VALUE 'blocked_quota';

-- Campo para registrar o motivo do bloqueio por quota hard, preenchido quando
-- status = 'blocked_quota'. Nulo em todos os outros status.
ALTER TABLE validation
  ADD COLUMN IF NOT EXISTS quota_blocked_reason text;

-- Comentário de documentação (metadado, não afeta o schema).
COMMENT ON COLUMN validation.quota_blocked_reason IS
  'Motivo do bloqueio por quota hard (ex.: "cota hard atingida no período corrente"). Preenchido apenas quando status = blocked_quota.';

-- Índice para consultas de validações bloqueadas por quota por tenant.
CREATE INDEX IF NOT EXISTS idx_validation_blocked_quota
  ON validation (tenant_id, quota_blocked_reason)
  WHERE quota_blocked_reason IS NOT NULL;
