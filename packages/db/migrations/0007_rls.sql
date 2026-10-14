SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

ALTER TABLE subject ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subject
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE validation ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON validation
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE validation_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation_idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON validation_idempotency
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE usage_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_event
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE webhook_endpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoint FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_endpoint
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE webhook_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_delivery
  USING (
    EXISTS (
      SELECT 1 FROM webhook_endpoint e
      WHERE e.endpoint_id = webhook_delivery.endpoint_id
        AND e.tenant_id = app_tenant_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM webhook_endpoint e
      WHERE e.endpoint_id = webhook_delivery.endpoint_id
        AND e.tenant_id = app_tenant_id()
    )
  );

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id IS NULL OR tenant_id = app_tenant_id())
  WITH CHECK (tenant_id IS NULL OR tenant_id = app_tenant_id());
