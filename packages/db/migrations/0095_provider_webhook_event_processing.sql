SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- 0095 — Processamento idempotente de webhooks
-- ============================================================================
-- A 0094 criou provider_webhook_event com GRANT SELECT, INSERT. O handler de
-- webhooks precisa também registrar a conclusão (processed_at), a falha
-- (processing_error), o número de retentativas (retry_count) e o instante da
-- reserva (claimed_at). O UPDATE é restrito a essas colunas para não ampliar
-- a superfície de escrita.
--
-- Nota: provider_webhook_event não tem RLS por tenant — a tabela é um ledger
-- por provider (sem tenant_id) e não é exposta a usuários finais. A exceção à
-- convenção de RLS em tabelas webhook_* está registrada em
-- docs/adr/0046-provider-webhook-event-sem-rls-por-tenant.md.
--
-- A sequência do bigserial também precisa de USAGE: o GRANT ALL SEQUENCES da
-- 0008 só alcançou as sequências existentes naquela migration.

ALTER TABLE provider_webhook_event
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

-- Eventos já existentes: a reserva é o próprio instante de criação.
UPDATE provider_webhook_event
  SET claimed_at = created_at
  WHERE claimed_at IS NULL;

GRANT UPDATE (processed_at, processing_error, retry_count, claimed_at)
  ON provider_webhook_event TO app_user;

GRANT USAGE, SELECT
  ON SEQUENCE provider_webhook_event_id_seq TO app_user;
