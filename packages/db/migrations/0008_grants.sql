SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

GRANT USAGE ON SCHEMA public TO app_user;

GRANT SELECT ON
  tenant, legal_basis, api_key,
  ref_receita_estabelecimento, ref_receita_empresa, ref_receita_socio,
  ref_receita_simples, ref_cnefe_address, ref_cep, ref_known_shared_address,
  canonical_address, address_profile, address_signal_cache, evidence
TO app_user;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  subject, validation, validation_idempotency, signal
TO app_user;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  webhook_endpoint, webhook_delivery
TO app_user;

GRANT SELECT, INSERT, UPDATE ON usage_event TO app_user;

GRANT SELECT, INSERT, UPDATE ON outbox TO app_user;

GRANT SELECT, INSERT ON audit_log TO app_user;

GRANT UPDATE (last_used_at) ON api_key TO app_user;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
