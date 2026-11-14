SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- F4.3 → F1.2/F1.3 — vínculo explícito entre documento do Holder e a Claim.
--
-- O artefato enviado pelo Holder continua pertencendo à
-- `holder_information_request` (`evidence_artifact.claim_evidence_id IS NULL`
-- e `holder_information_request_id IS NOT NULL`). A check constraint
-- `evidence_artifact_one_source_check` é preservada e o artefato continua
-- write-once (sem UPDATE).
--
-- O que faltava era uma relação explicita entre esse artefato e o recibo
-- `claim_evidence` (`source = 'customer_submitted_document'`) criado para a
-- Claim da Validation. Sem ela, a F1.3 não consegue provar qual documento
-- físico lastreia a verificação quando existe mais de um artefato no tenant.
--
-- Por que uma tabela de associação e não copiar o artefato ou preencher
-- `claim_evidence_id`:
--   - copiar bytes duplicaria PII/storage;
--   - preencher `claim_evidence_id` violaria a fonte exclusiva do artefato e
--     perderia a proveniência da solicitação do Holder;
--   - a associação mantém as duas origens ao mesmo tempo e é 1:1 por banco.
--
-- Cardinalidade 1:1 garantida no banco:
--   - `artifact_id` é PK → um artefato participa de no máximo um recibo;
--   - UNIQUE (`claim_evidence_id`) → um recibo tem no máximo um artefato.
-- A cardinalidade 1:1 Validation ↔ documento continua sendo a barreira já
-- existente `idx_claim_evidence_customer_document_uq` em `claim_evidence`.
--
-- FKs compostas provam que artefato, recibo e vínculo são do MESMO tenant.
-- `ON DELETE CASCADE` acompanha a retenção/erasure: quando o artefato (30 dias)
-- ou o `claim_evidence` (erasure do subject/validation) é removido, o vínculo
-- também é. Nenhum dos dois lados é alterado.

CREATE TABLE evidence_artifact_claim_evidence (
  artifact_id       uuid PRIMARY KEY,
  claim_evidence_id uuid NOT NULL,
  tenant_id         uuid NOT NULL REFERENCES tenant (tenant_id),
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT evidence_artifact_claim_evidence_artifact_tenant_fk
    FOREIGN KEY (artifact_id, tenant_id)
    REFERENCES evidence_artifact (artifact_id, tenant_id)
    ON DELETE CASCADE,

  CONSTRAINT evidence_artifact_claim_evidence_claim_evidence_tenant_fk
    FOREIGN KEY (claim_evidence_id, tenant_id)
    REFERENCES claim_evidence (claim_evidence_id, tenant_id)
    ON DELETE CASCADE,

  CONSTRAINT evidence_artifact_claim_evidence_claim_evidence_uq
    UNIQUE (claim_evidence_id)
);

CREATE INDEX evidence_artifact_claim_evidence_tenant_claim_idx
  ON evidence_artifact_claim_evidence (tenant_id, claim_evidence_id);

ALTER TABLE evidence_artifact_claim_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_artifact_claim_evidence FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON evidence_artifact_claim_evidence
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- Sem UPDATE: o vínculo é imutável. DELETE é necessário para cascata de
-- retenção/erasure (o cascade do PostgreSQL não depende do grant da aplicação,
-- mas o grant mantém o padrão operacional das demais tabelas).
GRANT SELECT, INSERT, DELETE ON evidence_artifact_claim_evidence TO app_user;