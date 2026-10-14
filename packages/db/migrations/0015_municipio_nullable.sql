SET lock_timeout = '5s';
SET statement_timeout = '300s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

ALTER TABLE ref_receita_municipio ALTER COLUMN codigo_ibge DROP NOT NULL;
ALTER TABLE ref_receita_municipio ALTER COLUMN uf DROP NOT NULL;
