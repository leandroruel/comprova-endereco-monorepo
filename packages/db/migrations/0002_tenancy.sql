SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

CREATE TYPE doc_type AS ENUM ('CPF','CNPJ');
CREATE TYPE val_mode AS ENUM ('fast','deep','auto');
CREATE TYPE val_status AS ENUM ('queued','running','partial','completed','failed','expired');
CREATE TYPE verdict_t AS ENUM ('CONFIRMED_COMMERCIAL','SHARED_VIRTUAL','OCCUPIED_BY_OTHER_ENTITY',
                               'RESIDENTIAL','NOT_FOUND','FOREIGN','INCONSISTENT','INSUFFICIENT_EVIDENCE');
CREATE TYPE stance_t AS ENUM ('supports','contradicts','neutral','unknown');
CREATE TYPE geo_precision AS ENUM ('ROOFTOP','RANGE_INTERPOLATED','GEOMETRIC_CENTER','APPROXIMATE','NONE');

CREATE TABLE tenant (
  tenant_id       uuid PRIMARY KEY,
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'active',
  rate_limit_rps  int  NOT NULL DEFAULT 50,
  burst           int  NOT NULL DEFAULT 100,
  monthly_quota   bigint,
  data_region     text NOT NULL DEFAULT 'sa-east-1',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_key (
  api_key_id   uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant,
  key_prefix   text NOT NULL,
  key_hash     bytea NOT NULL,
  scopes       text[] NOT NULL DEFAULT '{validate:read,validate:write}',
  revoked_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX api_key_prefix_uq ON api_key (key_prefix) WHERE revoked_at IS NULL;

CREATE TABLE legal_basis (
  code        text PRIMARY KEY,
  description text NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'disabled';
  END IF;
END $$;
