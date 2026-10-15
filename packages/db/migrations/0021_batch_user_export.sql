SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

ALTER TABLE batch ADD COLUMN user_id text REFERENCES "user"(id);
ALTER TABLE batch_item ADD COLUMN verdict text;
ALTER TABLE batch_item ADD COLUMN confidence real;
ALTER TABLE batch_item ADD COLUMN explanation text;

CREATE INDEX idx_batch_user ON batch (user_id, created_at DESC) WHERE user_id IS NOT NULL;
