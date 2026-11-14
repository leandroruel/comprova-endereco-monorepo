SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- PR #73 (revisão) — unicidade do comprovante do cliente por Validation.
-- =====================================================================
-- `idx_claim_evidence_customer_document_uq` garante no máximo um documento
-- `customer_submitted_document` por CLAIM. Como uma Validation pode ter mais
-- de uma Claim (ex.: `business_registered_address` e `address_exists`), o
-- índice sozinho permitia dois recibos na mesma Validation.
--
-- Esta tabela materializa a relação explícita recibo ↔ Validation:
--   - `validation_id` é PK → no máximo um recibo por Validation;
--   - `UNIQUE (claim_evidence_id)` → um recibo pertence a no máximo uma
--     Validation.
--
-- Não há FK para `validation`: a PK é composta `(validation_id, created_at)`
-- e a tabela é particionada por range de `created_at`; o PostgreSQL não aceita
-- FK para parte de uma PK particionada. A aplicação valida existência e tenant
-- sob o lock da linha da Validation (mesma ordem do intake F1.1). A FK composta
-- com `claim_evidence` garante que recibo e vínculo são do MESMO tenant.
--
-- `ON DELETE CASCADE` acompanha a retenção/erasure: quando o recibo é apagado
-- (expiração da Validation ou erasure do titular), o vínculo também é. Nenhuma
-- constraint existente é removida ou enfraquecida.

CREATE TABLE validation_customer_document (
  validation_id     uuid PRIMARY KEY,
  claim_evidence_id uuid NOT NULL,
  tenant_id         uuid NOT NULL REFERENCES tenant (tenant_id),
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT validation_customer_document_claim_evidence_tenant_fk
    FOREIGN KEY (claim_evidence_id, tenant_id)
    REFERENCES claim_evidence (claim_evidence_id, tenant_id)
    ON DELETE CASCADE,

  CONSTRAINT validation_customer_document_claim_evidence_uq
    UNIQUE (claim_evidence_id)
);

CREATE INDEX validation_customer_document_tenant_idx
  ON validation_customer_document (tenant_id);

ALTER TABLE validation_customer_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation_customer_document FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON validation_customer_document
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- Sem UPDATE: o vínculo recibo ↔ Validation é imutável. DELETE é necessário
-- para a cascata de retenção/erasure.
GRANT SELECT, INSERT, DELETE ON validation_customer_document TO app_user;

-- =====================================================================
-- Backfill — dados existentes.
-- =====================================================================
-- Cada Validation recebe no máximo UM vínculo. Quando já existem dois recibos
-- históricos (possível antes desta constraint, porque a unicidade era por
-- Claim), a escolha é determinística e prefere o recibo da Claim canônica
-- derivada do subject (CNPJ → business_registered_address; CPF →
-- address_exists), depois o mais antigo. Os recibos excedentes permanecem no
-- histórico, mas não são adotados pelo fluxo do Holder; a aplicação os trata
-- como inconsistência em vez de reutilizá-los.
INSERT INTO validation_customer_document (validation_id, claim_evidence_id, tenant_id)
SELECT DISTINCT ON (c.validation_id)
  c.validation_id,
  ce.claim_evidence_id,
  ce.tenant_id
FROM claim_evidence ce
JOIN claim c
  ON c.claim_id = ce.claim_id
 AND c.tenant_id = ce.tenant_id
JOIN subject s
  ON s.subject_id = c.subject_id
 AND s.tenant_id = c.tenant_id
WHERE ce.source = 'customer_submitted_document'
ORDER BY
  c.validation_id,
  CASE
    WHEN (s.doc_type = 'CNPJ' AND c.type = 'business_registered_address')
      OR (s.doc_type <> 'CNPJ' AND c.type = 'address_exists')
    THEN 0
    ELSE 1
  END,
  ce.created_at,
  ce.claim_evidence_id;