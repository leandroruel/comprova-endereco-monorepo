SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

CREATE TABLE subject (
  subject_id   uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant,
  doc_type     doc_type NOT NULL,
  doc_hmac     bytea NOT NULL,
  doc_enc      bytea,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, doc_type, doc_hmac)
);

CREATE TABLE validation (
  validation_id    uuid NOT NULL,
  tenant_id        uuid NOT NULL,
  subject_id       uuid NOT NULL REFERENCES subject,
  address_id       uuid,
  mode             val_mode NOT NULL,
  status           val_status NOT NULL,
  verdict          verdict_t,
  score            real,
  confidence       real,
  policy_version   text NOT NULL,
  legal_basis      text NOT NULL REFERENCES legal_basis,
  consent_ref      text,
  idempotency_key  text,
  workflow_id      text,
  explanation      jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (validation_id, created_at)
) PARTITION BY RANGE (created_at);

DO $$
DECLARE
  d date := date_trunc('month', now())::date - interval '2 months';
  end_d date := date_trunc('month', now())::date + interval '14 months';
BEGIN
  WHILE d < end_d LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      'validation_' || to_char(d, 'YYYY_MM'), 'validation',
      d, d + interval '1 month');
    d := d + interval '1 month';
  END LOOP;
END $$;

CREATE UNIQUE INDEX validation_idem_uq ON validation (tenant_id, idempotency_key, created_at)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_validation_tenant_time ON validation (tenant_id, created_at DESC);
CREATE INDEX idx_validation_subject ON validation (subject_id, created_at DESC);

CREATE TABLE validation_idempotency (
  tenant_id        uuid NOT NULL,
  idempotency_key  text NOT NULL,
  validation_id    uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key)
);

CREATE TABLE signal (
  signal_id        uuid NOT NULL,
  validation_id    uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  checker_id       text NOT NULL,
  checker_version  text NOT NULL,
  stance           stance_t NOT NULL,
  strength         real NOT NULL CHECK (strength BETWEEN 0 AND 1),
  confidence       real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  source           text NOT NULL,
  observed_at      timestamptz NOT NULL,
  ttl_seconds      int NOT NULL,
  detail           jsonb NOT NULL DEFAULT '{}',
  evidence_id      uuid,
  PRIMARY KEY (signal_id, created_at)
) PARTITION BY RANGE (created_at);

DO $$
DECLARE
  d date := date_trunc('month', now())::date - interval '2 months';
  end_d date := date_trunc('month', now())::date + interval '14 months';
BEGIN
  WHILE d < end_d LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      'signal_' || to_char(d, 'YYYY_MM'), 'signal',
      d, d + interval '1 month');
    d := d + interval '1 month';
  END LOOP;
END $$;

CREATE INDEX idx_signal_validation ON signal (validation_id);

CREATE TABLE address_signal_cache (
  address_id       uuid NOT NULL REFERENCES canonical_address,
  checker_id       text NOT NULL,
  checker_version  text NOT NULL,
  stance           stance_t NOT NULL,
  strength         real NOT NULL CHECK (strength BETWEEN 0 AND 1),
  confidence       real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  source           text NOT NULL,
  observed_at      timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  detail           jsonb NOT NULL DEFAULT '{}',
  evidence_id      uuid,
  PRIMARY KEY (address_id, checker_id, checker_version)
);
CREATE INDEX idx_asc_expires ON address_signal_cache (expires_at);

CREATE TABLE evidence (
  evidence_id     uuid PRIMARY KEY,
  kind            text NOT NULL,
  provider        text NOT NULL,
  s3_uri          text NOT NULL,
  sha256          bytea NOT NULL,
  captured_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retention_until timestamptz NOT NULL
);
