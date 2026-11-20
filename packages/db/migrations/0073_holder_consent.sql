SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- F4.1 — consentimento do Holder antes do envio de documentos.
--
-- O Holder (sem conta) registra um aceite explícito dos termos aplicáveis
-- à solicitação antes de poder enviar documentos. O consentimento é
-- vinculado exclusivamente à solicitação (holder_information_request) e ao
-- tenant, nunca a outro Subject/Claim/Validation.
--
-- Não armazena texto jurídico nem dados pessoais do Holder: apenas a versão
-- dos termos apresentados, o estado do aceite, o timestamp do relógio do
-- banco e um identificador de evento de auditoria.

CREATE TABLE holder_consent (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  holder_information_request_id uuid NOT NULL,
  terms_version text NOT NULL,
  state text NOT NULL DEFAULT 'granted' CHECK (state IN ('granted', 'withdrawn')),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Integridade referencial composta: o consentimento pertence ao mesmo tenant da solicitação.
  CONSTRAINT holder_consent_request_tenant_fk
    FOREIGN KEY (holder_information_request_id, tenant_id)
    REFERENCES holder_information_request (id, tenant_id),
  -- Um consentimento por solicitação (idempotência de aceite).
  CONSTRAINT holder_consent_request_unique
    UNIQUE (holder_information_request_id)
);
CREATE INDEX idx_holder_consent_tenant ON holder_consent (tenant_id);
CREATE INDEX idx_holder_consent_request ON holder_consent (holder_information_request_id);
GRANT SELECT, INSERT ON holder_consent TO app_user;
-- Sem UPDATE: o consentimento é imutável após o aceite. Não há DELETE.

ALTER TABLE holder_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE holder_consent FORCE ROW LEVEL SECURITY;
CREATE POLICY holder_consent_tenant_isolation ON holder_consent
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- Comentário documentando que o texto dos termos é de responsabilidade do
-- produto (pendente de conteúdo aprovado): esta tabela apenas registra a
-- versão aceita e o timestamp do aceite.
