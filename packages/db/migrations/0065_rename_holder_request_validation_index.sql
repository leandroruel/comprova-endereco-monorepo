SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- PR 1 — Alinhar nome do índice de holder_information_request.validation_id.
--
-- A migration 0064 criou o índice com o nome `idx_holder_information_request_validation_idx`,
-- enquanto o schema Drizzle declara `holder_information_request_validation_idx`.
-- Como 0064 já foi aplicada, não a alteramos. Esta migration aditiva renomeia o
-- índice existente para bater com o schema.
--
-- RENAME INDEX adquire um lock SHARE no índice, não bloqueando leituras nem
-- escritas na tabela de forma prolongada.

ALTER INDEX idx_holder_information_request_validation_idx
  RENAME TO holder_information_request_validation_idx;
