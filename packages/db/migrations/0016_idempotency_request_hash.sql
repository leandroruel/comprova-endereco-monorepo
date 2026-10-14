SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

ALTER TABLE validation_idempotency ADD COLUMN request_hash text;
ALTER TABLE validation_idempotency ADD COLUMN response_address jsonb;
