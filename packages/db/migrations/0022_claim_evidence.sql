SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

CREATE TYPE claim_type AS ENUM ('business_registered_address', 'address_exists');
CREATE TYPE claim_subject_type AS ENUM ('organization', 'person');
CREATE TYPE claim_target_type AS ENUM ('address');
CREATE TYPE evidence_stance AS ENUM ('supports', 'contradicts', 'unknown');

CREATE TABLE claim (
  claim_id       uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenant,
  validation_id  uuid NOT NULL,
  subject_id     uuid NOT NULL REFERENCES subject ON DELETE CASCADE,
  address_id     uuid,
  type           claim_type NOT NULL,
  subject_type   claim_subject_type NOT NULL,
  target_type    claim_target_type NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (validation_id, type)
);

ALTER TABLE claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON claim
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

CREATE INDEX idx_claim_validation ON claim (validation_id);
CREATE INDEX idx_claim_tenant_time ON claim (tenant_id, created_at DESC);

CREATE TABLE claim_evidence (
  evidence_id     uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenant,
  claim_id        uuid NOT NULL REFERENCES claim ON DELETE CASCADE,
  signal_id       uuid,
  checker         text NOT NULL,
  checker_version text NOT NULL,
  stance          evidence_stance NOT NULL,
  strength        real NOT NULL CHECK (strength BETWEEN 0 AND 1),
  confidence      real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  source          text NOT NULL,
  observed_at     timestamptz NOT NULL,
  ttl_seconds     integer NOT NULL,
  expires_at      timestamptz NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE claim_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON claim_evidence
  USING (tenant_id = app_tenant_id())
  WITH CHECK (
    tenant_id = app_tenant_id()
    AND EXISTS (
      SELECT 1 FROM claim c
      WHERE c.claim_id = claim_evidence.claim_id
        AND c.tenant_id = app_tenant_id()
    )
  );

CREATE INDEX idx_evidence_claim ON claim_evidence (claim_id);
CREATE INDEX idx_evidence_tenant_claim ON claim_evidence (tenant_id, claim_id);
CREATE INDEX idx_evidence_expires ON claim_evidence (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON claim, claim_evidence TO app_user;
