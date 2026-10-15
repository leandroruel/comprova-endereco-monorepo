SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

ALTER TABLE validation ADD COLUMN user_id text REFERENCES "user"(id);
CREATE INDEX idx_validation_user ON validation (user_id, created_at DESC) WHERE user_id IS NOT NULL;
