SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- F4.1 — armazena o hash SHA-256 dos termos efetivamente aceitos no
-- consentimento do Holder. Permite rastrear exatamente qual conteúdo jurídico
-- foi apresentado e aceito em cada solicitação.
ALTER TABLE holder_consent
  ADD COLUMN terms_hash text;

-- Comentário documentando a coluna.
COMMENT ON COLUMN holder_consent.terms_hash IS
  'SHA-256 do conteúdo dos termos de onboarding efetivamente aceitos pelo Holder.';

GRANT SELECT, INSERT ON holder_consent TO app_user;
