SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- F0.1: artefato de evidência tenant-scoped (ADR-0035)
-- =====================================================================
-- `evidence` continua sendo o descritor material legado (global, sem RLS),
-- usado pelo street view. Documentos de clientes/titulares são PII e NÃO podem
-- viver nessa tabela: nasce `evidence_artifact`, escopada por tenant e ligada
-- à observação (`claim_evidence`), não ao descritor global.
--
-- Por que NÃO um FK para `evidence`: `evidence` não tem `tenant_id`; um FK
-- permitiria que o tenant A apontasse para material do tenant B. A FK composta
-- (claim_evidence_id, tenant_id) prova no banco que o artefato acompanha o
-- tenant da observação.
--
-- Não há binário no Postgres: apenas metadados + `storage_key` opaca. O objeto
-- vive no object storage existente (`ObjectStore`).

-- 1) Chave única de apoio para a FK composta.
--    `claim_evidence_id` já é PK; a chave composta é exigida pelo PostgreSQL
--    para a FK (claim_evidence_id, tenant_id).
CREATE UNIQUE INDEX claim_evidence_id_tenant_uq
  ON claim_evidence (claim_evidence_id, tenant_id);
ALTER TABLE claim_evidence
  ADD CONSTRAINT claim_evidence_id_tenant_uq
  UNIQUE USING INDEX claim_evidence_id_tenant_uq;

-- 2) Metadados do artefato físico.
CREATE TABLE evidence_artifact (
  artifact_id       uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenant (tenant_id),
  claim_evidence_id uuid NOT NULL,
  -- Chave opaca no object storage (nunca URL pública/presigned).
  storage_key       text NOT NULL,
  content_type      text NOT NULL,
  size_bytes        bigint NOT NULL,
  sha256            bytea NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Limite de retenção. A remoção efetiva do objeto é feita pelo fluxo de
  -- retenção/erasure; a linha sozinha não apaga o objeto.
  retention_until   timestamptz NOT NULL,

  -- Mesmo tenant da observação. Um INSERT com claim_evidence de outro tenant
  -- falha aqui (o par (id, tenant) não existe).
  CONSTRAINT evidence_artifact_claim_evidence_tenant_fk
    FOREIGN KEY (claim_evidence_id, tenant_id)
    REFERENCES claim_evidence (claim_evidence_id, tenant_id)
    ON DELETE RESTRICT,

  -- Integridade dos metadados. O serviço também valida, mas o banco é a
  -- última linha de defesa.
  CONSTRAINT evidence_artifact_size_ck
    CHECK (size_bytes BETWEEN 1 AND 52428800),
  CONSTRAINT evidence_artifact_sha256_ck
    CHECK (octet_length(sha256) = 32),
  CONSTRAINT evidence_artifact_content_type_ck
    CHECK (length(content_type) BETWEEN 1 AND 255),
  CONSTRAINT evidence_artifact_storage_key_ck
    CHECK (length(storage_key) BETWEEN 1 AND 512),

  -- A chave precisa estar no namespace do próprio tenant. Impede que um
  -- INSERT escopado no tenant A grave/aponte para o prefixo do tenant B.
  CONSTRAINT evidence_artifact_storage_key_tenant_ck
    CHECK (storage_key LIKE 'tenants/' || tenant_id::text || '/evidence/%')
);

-- Deduplicação de storage_key DENTRO do tenant (o mesmo objeto lógico não
-- pode ser registrado duas vezes pelo mesmo tenant).
CREATE UNIQUE INDEX evidence_artifact_tenant_storage_key_uq
  ON evidence_artifact (tenant_id, storage_key);

CREATE INDEX evidence_artifact_tenant_claim_idx
  ON evidence_artifact (tenant_id, claim_evidence_id);

CREATE INDEX evidence_artifact_retention_idx
  ON evidence_artifact (retention_until);

-- 3) RLS: mesmo padrão de claim/claim_evidence/validation.
ALTER TABLE evidence_artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_artifact FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON evidence_artifact
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- Sem UPDATE: o artefato bruto é write-once. DELETE é necessário para
-- retenção/erasure (o runtime apaga o objeto antes da linha).
GRANT SELECT, INSERT, DELETE ON evidence_artifact TO app_user;

-- 4) Imutabilidade defensiva (inclusive para admin/owner).
CREATE OR REPLACE FUNCTION evidence_artifact_immutable_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'evidence_artifact é imutável: o artefato bruto não pode ser reescrito';
END $$;

CREATE TRIGGER evidence_artifact_immutable_guard_trg
  BEFORE UPDATE ON evidence_artifact
  FOR EACH ROW EXECUTE FUNCTION evidence_artifact_immutable_guard();
