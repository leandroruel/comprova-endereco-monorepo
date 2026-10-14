SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

CREATE TABLE outbox (
  outbox_id     bigserial PRIMARY KEY,
  aggregate     text NOT NULL,
  aggregate_id  uuid NOT NULL,
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX idx_outbox_unpub ON outbox (outbox_id) WHERE published_at IS NULL;

CREATE TABLE webhook_endpoint (
  endpoint_id  uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant,
  url          text NOT NULL,
  secret_enc   bytea NOT NULL,
  events       text[] NOT NULL,
  active       boolean NOT NULL DEFAULT true
);

CREATE TABLE webhook_delivery (
  delivery_id    uuid PRIMARY KEY,
  endpoint_id    uuid NOT NULL REFERENCES webhook_endpoint,
  validation_id  uuid NOT NULL,
  attempt        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  status         text NOT NULL,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_event (
  tenant_id     uuid NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL,
  units         int NOT NULL DEFAULT 1,
  cost_micros   bigint,
  validation_id uuid
) PARTITION BY RANGE (occurred_at);

DO $$
DECLARE
  d date := date_trunc('month', now())::date - interval '2 months';
  end_d date := date_trunc('month', now())::date + interval '14 months';
BEGIN
  WHILE d < end_d LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      'usage_event_' || to_char(d, 'YYYY_MM'), 'usage_event',
      d, d + interval '1 month');
    d := d + interval '1 month';
  END LOOP;
END $$;

CREATE TABLE audit_log (
  audit_id     bigserial PRIMARY KEY,
  tenant_id    uuid,
  actor        text NOT NULL,
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  ip           inet,
  at           timestamptz NOT NULL DEFAULT now(),
  details      jsonb NOT NULL DEFAULT '{}'
);
