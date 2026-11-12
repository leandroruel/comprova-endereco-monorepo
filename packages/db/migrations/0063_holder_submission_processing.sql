SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- F4.3 — tabela de processamento de submissões do Holder
CREATE TABLE IF NOT EXISTS holder_submission_processing (
    processing_id uuid PRIMARY KEY,
    holder_information_request_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    state text NOT NULL DEFAULT 'awaiting',
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    CONSTRAINT holder_submission_processing_request_tenant_fk
        FOREIGN KEY (holder_information_request_id, tenant_id)
        REFERENCES holder_information_request (id, tenant_id),
    CONSTRAINT holder_submission_processing_state_check
        CHECK (state IN ('awaiting', 'processing', 'processed', 'partial', 'failed')),
    CONSTRAINT holder_submission_processing_request_unique
        UNIQUE (holder_information_request_id)
);
CREATE INDEX idx_holder_submission_processing_tenant ON holder_submission_processing (tenant_id);
CREATE INDEX idx_holder_submission_processing_state ON holder_submission_processing (tenant_id, state);
CREATE INDEX idx_holder_submission_processing_request ON holder_submission_processing (holder_information_request_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON holder_submission_processing TO app_user;
