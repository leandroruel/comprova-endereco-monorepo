SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- FASE 15: status/revogação de credenciais (ADR-0027)
-- =====================================================================
-- A credencial emitida pela API não é persistida: o documento é assinado e
-- devolvido. Para permitir revogação sem transformar o projeto em um registry
-- SSI, esta migration cria SOMENTE o estado mínimo por credencial:
--
--   credential_id  → identificador público opaco (base64url(sha256(...)))
--   tenant_id      → dono; isolamento por RLS
--   issuer_scope   → digest do tenant que aparece na URL pública do issuer
--   status         → ACTIVE | REVOKED
--   created_at     → quando a credencial foi registrada (emissão)
--   revoked_at     → quando passou a REVOKED (null enquanto ACTIVE)
--
-- Não há FK para validation/claim/claim_evidence/evidence/subject: o status
-- PRECISA sobreviver à retenção do material físico e da validation. O
-- identificador não é o validation_id; é um digest unidirecional que inclui o
-- issuer.id (ADR-0027), então não revela o UUID interno e não correlaciona
-- tenants. A tabela não guarda segredo, documento, subject, evidence nem
-- chave privada.
--
-- Transição permitida: ACTIVE → REVOKED. REVOKED é terminal (não há
-- reativação); o trigger abaixo recusa qualquer UPDATE de uma linha REVOKED.
-- Não há DELETE concedido ao app: a revogação é monotônica e não é apagada
-- pela retenção.

CREATE TABLE credential_status (
  credential_id text PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant (tenant_id),
  issuer_scope  text NOT NULL,
  status        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  CONSTRAINT credential_status_value_ck
    CHECK (status IN ('ACTIVE', 'REVOKED')),
  CONSTRAINT credential_status_consistency_ck
    CHECK (
      (status = 'ACTIVE' AND revoked_at IS NULL) OR
      (status = 'REVOKED' AND revoked_at IS NOT NULL)
    ),
  -- O id público é um digest de 43 chars base64url; o escopo também. A checagem
  -- defensiva impede linhas com identificadores arbitrários.
  CONSTRAINT credential_status_id_format_ck
    CHECK (credential_id ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT credential_status_scope_format_ck
    CHECK (issuer_scope ~ '^[A-Za-z0-9_-]{43}$')
);

-- O endpoint público resolve por (issuer_scope, credential_id). A PK cobre o
-- credential_id; o índice abaixo cobre a leitura por issuer.
CREATE INDEX credential_status_scope_idx ON credential_status (issuer_scope);

ALTER TABLE credential_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_status FORCE ROW LEVEL SECURITY;

-- Leitura/escrita escopada pelo tenant dono: A não lê nem altera o status de B.
CREATE POLICY tenant_isolation ON credential_status
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- O endpoint público `GET /issuers/:scope/credentials/:id/status` precisa ler
-- SEM contexto de tenant. A tabela só carrega status e identificadores
-- públicos (o credential_id é o que já aparece na credencial; o issuer_scope já
-- aparece na URL do issuer). Nenhum dado pessoal/segredo é exposto.
CREATE POLICY public_status_read ON credential_status FOR SELECT USING (true);

-- A aplicação registra ACTIVE na emissão e promove para REVOKED na revogação.
-- Não há DELETE: a retenção de evidence/validation não toca nesta tabela.
GRANT SELECT, INSERT, UPDATE ON credential_status TO app_user;

-- Monotonicidade e imutabilidade da identidade da linha. O CHECK já garante a
-- consistência status/revoked_at; o trigger garante que REVOKED nunca volta a
-- ACTIVE (nem é reescrito por UPDATE).
CREATE FUNCTION credential_status_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.credential_id <> OLD.credential_id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.issuer_scope <> OLD.issuer_scope
     OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'credential_status: identidade é imutável';
  END IF;

  IF OLD.status = 'REVOKED' THEN
    RAISE EXCEPTION 'credential_status é monotônico: REVOKED não pode ser alterado';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER credential_status_guard_trg
  BEFORE UPDATE ON credential_status
  FOR EACH ROW EXECUTE FUNCTION credential_status_guard();
