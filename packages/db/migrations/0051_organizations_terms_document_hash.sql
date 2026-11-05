SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- Armazena o hash SHA-256 do documento jurídico dos termos de onboarding,
-- definido exclusivamente pelo servidor. Permite vincular de forma
-- verificável o aceite registrado em terms_accepted_at ao documento
-- efetivamente apresentado ao usuário. Ausente indica que não há
-- documento oficial disponível para aceite.
ALTER TABLE tenant ADD COLUMN terms_document_hash text;

-- A aplicação precisa ler esta coluna para expor o hash do documento
-- via endpoint /organizations/terms-version.
GRANT SELECT ON tenant TO app_user;
