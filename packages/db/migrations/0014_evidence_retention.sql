SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

CREATE INDEX idx_evidence_retention ON evidence (retention_until);

GRANT INSERT ON evidence TO app_user;
