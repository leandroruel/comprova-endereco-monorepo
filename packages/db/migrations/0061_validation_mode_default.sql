SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- F4.3/P0.3 — adiciona DEFAULT 'fast' às colunas mode de validation e batch.
--
-- Com a unificação do fluxo de validação (remoção dos caminhos fast/deep/auto),
-- as colunas mode continuam existindo nas tabelas para compatibilidade com dados
-- históricos, mas sempre receberão o valor 'fast' (único fluxo determinístico
-- do MVP). Adicionar DEFAULT evita que inserts existentes que não especificam
-- mode falhem por NOT NULL.
ALTER TABLE validation
  ALTER COLUMN mode SET DEFAULT 'fast';

ALTER TABLE batch
  ALTER COLUMN mode SET DEFAULT 'fast';
