SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- PR 1 — Associar solicitação de documentos do Holder a uma Validation.
--
-- Adiciona `validation_id` (opcional) a `holder_information_request`, permitindo
-- que uma solicitação do Holder seja vinculada explicitamente à validation do
-- Verifier que a originou.
--
-- A coluna é nullable para preservar compatibilidade com solicitações criadas
-- antes desta migration.
--
-- Não há FK direta para `validation` porque a PK de `validation` é composta
-- (validation_id, created_at) e particionada por range de created_at: o
-- PostgreSQL não permite FK para parte de uma PK particionada. A consistência
-- é garantida pela aplicação no momento da associação (mesmo tenant).
--
-- O relacionamento é um-para-muitos do lado da validation: uma validation pode
-- ter várias solicitações de documentos, mas cada solicitação pertence a no
-- máximo uma validation.

ALTER TABLE holder_information_request
  ADD COLUMN validation_id uuid;

-- Índice composto para consultas por tenant + validation (mesmo padrão do Drizzle).
CREATE INDEX idx_holder_information_request_validation_idx
  ON holder_information_request (tenant_id, validation_id);

-- Índice parcial para consulta rápida de solicitações por validation (mesmo tenant).
CREATE INDEX holder_information_request_validation_request_idx
  ON holder_information_request (validation_id)
  WHERE validation_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON holder_information_request TO app_user;
