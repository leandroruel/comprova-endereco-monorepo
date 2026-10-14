SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

CREATE TABLE batch (
  batch_id     uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant,
  status       text NOT NULL DEFAULT 'queued',
  total_items  int NOT NULL,
  mode         val_mode NOT NULL,
  legal_basis  text NOT NULL REFERENCES legal_basis,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE batch_item (
  item_id       uuid PRIMARY KEY,
  batch_id      uuid NOT NULL REFERENCES batch,
  tenant_id     uuid NOT NULL REFERENCES tenant,
  position      int NOT NULL,
  doc_type      doc_type NOT NULL,
  doc_digits    text NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  validation_id uuid,
  error_code    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  UNIQUE (batch_id, position)
);

CREATE INDEX idx_batch_item_pending ON batch_item (batch_id) WHERE status = 'pending';

ALTER TABLE batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE batch_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_item
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE ON batch, batch_item TO app_user;
