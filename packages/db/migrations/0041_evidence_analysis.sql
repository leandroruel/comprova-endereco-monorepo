SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- F1.2: análise do documento do cliente
-- =====================================================================
-- `claim_evidence` é imutável (trigger da 0028) e tem no máximo um documento
-- do cliente por claim (0040); `evidence_artifact` é write-once (0039). O
-- resultado da análise NÃO pode ser gravado em nenhum dos dois sem quebrar
-- auditabilidade/immutabilidade. Esta tabela append-only é a menor extensão
-- que persiste a observação estruturada, uma linha por
-- (`artifact_id`, `analyzer`, `analyzer_version`, `contract_version`).
--
-- O resultado é uma observação NÃO CONFIÁVEL: `document`, `address` e `holder`
-- são dimensões independentes e `unavailable`/`inconclusive`/`unsupported`
-- nunca significam contradição. O verificador (F1.3/F2) consome esta linha.

-- 1) Chave de apoio para a FK composta (mesmo padrão da 0039).
CREATE UNIQUE INDEX evidence_artifact_id_tenant_uq
  ON evidence_artifact (artifact_id, tenant_id);
ALTER TABLE evidence_artifact
  ADD CONSTRAINT evidence_artifact_id_tenant_uq
  UNIQUE USING INDEX evidence_artifact_id_tenant_uq;

-- 2) Resultado/estado da análise.
CREATE TABLE evidence_analysis (
  analysis_id       uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenant (tenant_id),
  artifact_id       uuid NOT NULL,
  analyzer          text NOT NULL,
  analyzer_version  text NOT NULL,
  contract_version  text NOT NULL,
  status            text NOT NULL DEFAULT 'pending',
  result            jsonb,
  error_codes       text[] NOT NULL DEFAULT '{}',
  attempts          integer NOT NULL DEFAULT 0,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  analyzed_at       timestamptz,

  CONSTRAINT evidence_analysis_status_ck
    CHECK (status IN ('pending','analyzing','completed','inconclusive','unsupported','unavailable','failed')),
  CONSTRAINT evidence_analysis_attempts_ck
    CHECK (attempts >= 0),
  -- Uma linha de fila não tem resultado; uma linha terminal tem resultado e
  -- timestamp de análise. Isso impede `completed` sem `result` por bug/operador.
  CONSTRAINT evidence_analysis_terminal_result_ck
    CHECK (
      (status IN ('pending','analyzing') AND result IS NULL)
      OR (
        status IN ('completed','inconclusive','unsupported','unavailable','failed')
        AND result IS NOT NULL
        AND analyzed_at IS NOT NULL
        AND (result->>'status') IS NOT DISTINCT FROM status
      )
    ),
  -- Mesmo tenant do artefato. Um INSERT do tenant A apontando para artefato do
  -- tenant B falha aqui (o par (artifact_id, tenant_id) não existe).
  CONSTRAINT evidence_analysis_artifact_tenant_fk
    FOREIGN KEY (artifact_id, tenant_id)
    REFERENCES evidence_artifact (artifact_id, tenant_id)
    ON DELETE CASCADE,
  -- Uma linha por artefato + analisador + versão + contrato. Replay do upload
  -- ou retry do worker não cria segunda linha; uma nova versão preserva a
  -- anterior.
  CONSTRAINT evidence_analysis_artifact_analyzer_uq
    UNIQUE (artifact_id, analyzer, analyzer_version, contract_version)
);

CREATE INDEX evidence_analysis_status_idx
  ON evidence_analysis (status, updated_at);

CREATE INDEX evidence_analysis_tenant_artifact_idx
  ON evidence_analysis (tenant_id, artifact_id);

-- 3) RLS: mesmo padrão de `evidence_artifact`/`claim_evidence`.
ALTER TABLE evidence_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_analysis FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON evidence_analysis
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON evidence_analysis TO app_user;

-- 4) Imutabilidade defensiva: identidade não muda e o resultado terminal
--    (result não nulo) não é reescrito. Retry de um estado de fila
--    (`pending`/`analyzing` com result nulo) continua permitido.
CREATE OR REPLACE FUNCTION evidence_analysis_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.analysis_id <> OLD.analysis_id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.artifact_id <> OLD.artifact_id
     OR NEW.analyzer <> OLD.analyzer
     OR NEW.analyzer_version <> OLD.analyzer_version
     OR NEW.contract_version <> OLD.contract_version
     OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'evidence_analysis é imutável nos campos de identidade';
  END IF;

  IF OLD.result IS NOT NULL THEN
    RAISE EXCEPTION 'evidence_analysis: resultado terminal é imutável';
  END IF;

  IF NEW.result IS NOT NULL AND NEW.status IN ('pending','analyzing') THEN
    RAISE EXCEPTION 'evidence_analysis: status de fila não pode persistir resultado';
  END IF;

  IF NEW.result IS NOT NULL
     AND (NEW.result->>'status') IS DISTINCT FROM NEW.status
  THEN
    RAISE EXCEPTION 'evidence_analysis: status % não corresponde ao resultado', NEW.status;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER evidence_analysis_guard_trg
  BEFORE UPDATE ON evidence_analysis
  FOR EACH ROW EXECUTE FUNCTION evidence_analysis_guard();
