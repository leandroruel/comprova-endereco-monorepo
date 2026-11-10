SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- Solicitações de informações enviadas por um Verifier a um Holder.
--
-- Pertence ao database operacional (comprova_app). Nunca deve ser criada no
-- database de referência (comprova_reference).
--
-- O isolamento multi-tenant é aplicado por tenant_id com RLS, seguindo o
-- mesmo padrão de holder, kyc_process e validation.
CREATE TABLE holder_information_request (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  holder_id uuid NOT NULL,
  type text NOT NULL,
  purpose text NOT NULL,
  items jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'in_progress', 'completed', 'cancelled', 'expired')),
  expires_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  expired_at timestamptz,
  -- Integridade referencial composta: o holder pertence ao mesmo tenant da solicitação.
  CONSTRAINT holder_information_request_holder_tenant_fk
    FOREIGN KEY (holder_id, tenant_id)
    REFERENCES holder (holder_id, tenant_id),
  -- Chave única composta para integridade referencial com holder_information_request_event.
  CONSTRAINT holder_information_request_id_tenant_unique UNIQUE (id, tenant_id)
);
CREATE INDEX idx_holder_information_request_tenant ON holder_information_request (tenant_id);
CREATE INDEX idx_holder_information_request_holder ON holder_information_request (holder_id);
CREATE INDEX idx_holder_information_request_state ON holder_information_request (state);
CREATE INDEX idx_holder_information_request_expires_at ON holder_information_request (expires_at);
CREATE INDEX idx_holder_information_request_tenant_state ON holder_information_request (tenant_id, state);
CREATE INDEX idx_holder_information_request_tenant_holder ON holder_information_request (tenant_id, holder_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON holder_information_request TO app_user;

ALTER TABLE holder_information_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE holder_information_request FORCE ROW LEVEL SECURITY;
CREATE POLICY holder_information_request_tenant_isolation ON holder_information_request
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- Eventos de auditoria imutáveis para cada operação relevante na solicitação.
-- Segue o mesmo padrão de kyc_event: apenas SELECT e INSERT são permitidos.
CREATE TABLE holder_information_request_event (
  id uuid PRIMARY KEY,
  holder_information_request_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  event_type text NOT NULL,
  from_state text,
  to_state text NOT NULL,
  actor text NOT NULL,
  details text NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Integridade referencial composta: o evento pertence ao mesmo tenant da solicitação.
  CONSTRAINT holder_information_request_event_request_tenant_fk
    FOREIGN KEY (holder_information_request_id, tenant_id)
    REFERENCES holder_information_request (id, tenant_id)
);
CREATE INDEX idx_holder_information_request_event_request ON holder_information_request_event (holder_information_request_id);
CREATE INDEX idx_holder_information_request_event_tenant ON holder_information_request_event (tenant_id);
CREATE INDEX idx_holder_information_request_event_created_at ON holder_information_request_event (created_at);
GRANT SELECT, INSERT ON holder_information_request_event TO app_user;

ALTER TABLE holder_information_request_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE holder_information_request_event FORCE ROW LEVEL SECURITY;
CREATE POLICY holder_information_request_event_tenant_isolation ON holder_information_request_event
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
