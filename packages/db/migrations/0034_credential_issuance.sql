SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- FASE 24/B2: primeira emissão determinística por validation (ADR-0030)
-- =====================================================================
-- A credencial NÃO é persistida. Para que reemitir a mesma validation devolva
-- o MESMO documento assinado, guardamos apenas:
--
--   validation_id → uma emissão por validation (PK global)
--   tenant_id     → dono; RLS
--   issuer_scope  → escopo público do issuer (43 chars)
--   credential_id → ponteiro público de status (43 chars); é o "índice" do
--                   modelo atual, que não usa StatusList numérica
--   issued_at     → instante da PRIMEIRA prova (`proof.created`)
--   created_at    → auditoria da linha
--
-- Não há documento, subject, CPF/CNPJ, evidência, chave privada nem segredo.
-- Sem FK para validation/claim/evidence: a linha sobrevive à retenção, como
-- `credential_status`, e o `validation_id` é apenas o eixo de idempotência.
--
-- Append-only: a aplicação só INSERT/SELECT. Não há UPDATE/DELETE concedido e
-- o trigger recusa ambos, porque `issued_at` e o ponteiro de status são a
-- identidade da primeira emissão (mudá-los quebraria a reemissão byte a byte).

CREATE TABLE credential_issuance (
  validation_id uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant (tenant_id),
  issuer_scope  text NOT NULL,
  credential_id text NOT NULL,
  issued_at     timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credential_issuance_scope_format_ck
    CHECK (issuer_scope ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT credential_issuance_id_format_ck
    CHECK (credential_id ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT credential_issuance_credential_uq UNIQUE (credential_id)
);

CREATE INDEX credential_issuance_tenant_idx ON credential_issuance (tenant_id);

ALTER TABLE credential_issuance ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_issuance FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON credential_issuance
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT ON credential_issuance TO app_user;

CREATE FUNCTION credential_issuance_immutable_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'credential_issuance é append-only: a primeira emissão é imutável';
END $$;

CREATE TRIGGER credential_issuance_immutable_guard_trg
  BEFORE UPDATE OR DELETE ON credential_issuance
  FOR EACH ROW EXECUTE FUNCTION credential_issuance_immutable_guard();
