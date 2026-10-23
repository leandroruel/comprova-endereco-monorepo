SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- F1.3: backoff persistente da verificação do documento enviado
-- =====================================================================
-- `claim_evidence` é append-only e a verificação só materializa uma linha
-- quando o contexto está completo. Uma falha ou `skipped` não deixa estado no
-- modelo de evidência; sem esta tabela o candidato mais antigo voltaria a ser
-- escolhido em todo tick, podendo atrasar candidatos de outros tenants.
--
-- O estado é operacional, sem PII: analysis_id, contador de tentativas e
-- instante da próxima tentativa. O worker usa o pool administrativo; não há
-- grant para `app_user`. A FK composta exige que a tentativa pertença ao mesmo
-- tenant da análise e o cascade acompanha a retenção do artefato.

-- Chave de apoio para a FK composta (mesmo padrão de evidence_artifact).
CREATE UNIQUE INDEX evidence_analysis_id_tenant_uq
  ON evidence_analysis (analysis_id, tenant_id);

CREATE TABLE evidence_verification_attempt (
  analysis_id       uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenant (tenant_id),
  attempts          integer NOT NULL DEFAULT 1,
  last_attempt_at   timestamptz NOT NULL DEFAULT now(),
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  last_error_code   text,

  CONSTRAINT evidence_verification_attempt_attempts_ck
    CHECK (attempts >= 1),
  CONSTRAINT evidence_verification_attempt_analysis_tenant_fk
    FOREIGN KEY (analysis_id, tenant_id)
    REFERENCES evidence_analysis (analysis_id, tenant_id)
    ON DELETE CASCADE
);

CREATE INDEX evidence_verification_attempt_next_idx
  ON evidence_verification_attempt (next_attempt_at);

ALTER TABLE evidence_verification_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_verification_attempt FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON evidence_verification_attempt
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
