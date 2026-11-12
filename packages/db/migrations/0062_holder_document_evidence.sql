SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- F4.3 — vincular artefatos e análises de evidência diretamente a solicitações
-- do Holder (holder_information_request), sem criar claim/validation.
--
-- Hoje `evidence_artifact` exige `claim_evidence_id` NOT NULL com FK para
-- `claim_evidence`, e `evidence_analysis` exige `artifact_id` com FK para
-- `evidence_artifact`. Isso força qualquer artefato a passar pelo domínio de
-- validação (validation → claim → claim_evidence), que não se aplica a
-- documentos enviados pelo Holder via F4.2.
--
-- Adicionamos `holder_information_request_id` como coluna opcional em ambas as
-- tabelas, permitindo que um artefato/analise seja vinculado diretamente a uma
-- solicitação do Holder. Exatamente um dos dois (claim_evidence_id ou
-- holder_information_request_id) deve estar preenchido, garantido por check
-- constraint e pela aplicação. A aplicação decide qual caminho usar com base na
-- origem do documento.

-- holder_information_request_id em evidence_artifact (opcional, FK composta)
ALTER TABLE evidence_artifact
  ADD COLUMN holder_information_request_id uuid;

ALTER TABLE evidence_artifact
  ADD CONSTRAINT evidence_artifact_holder_request_tenant_fk
    FOREIGN KEY (holder_information_request_id, tenant_id)
    REFERENCES holder_information_request (id, tenant_id);

-- Índice de suporte para consultas por solicitação do Holder
CREATE INDEX idx_evidence_artifact_holder_request
  ON evidence_artifact (tenant_id, holder_information_request_id);

-- holder_information_request_id em evidence_analysis (opcional, para rastreabilidade direta)
ALTER TABLE evidence_analysis
  ADD COLUMN holder_information_request_id uuid;

ALTER TABLE evidence_analysis
  ADD CONSTRAINT evidence_analysis_holder_request_tenant_fk
    FOREIGN KEY (holder_information_request_id, tenant_id)
    REFERENCES holder_information_request (id, tenant_id);

CREATE INDEX idx_evidence_analysis_holder_request
  ON evidence_analysis (tenant_id, holder_information_request_id);

-- Check constraint: exatamente um dos dois (claim_evidence_id ou
-- holder_information_request_id) deve estar preenchido.
ALTER TABLE evidence_artifact
  ADD CONSTRAINT evidence_artifact_one_source_check
    CHECK (
      (claim_evidence_id IS NOT NULL AND holder_information_request_id IS NULL)
      OR (claim_evidence_id IS NULL AND holder_information_request_id IS NOT NULL)
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON evidence_artifact TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON evidence_analysis TO app_user;
