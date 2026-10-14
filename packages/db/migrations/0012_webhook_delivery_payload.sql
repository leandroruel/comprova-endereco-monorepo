SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

ALTER TABLE webhook_delivery ADD COLUMN payload jsonb NOT NULL DEFAULT '{}';
ALTER TABLE webhook_delivery ADD COLUMN event_type text NOT NULL DEFAULT '';
