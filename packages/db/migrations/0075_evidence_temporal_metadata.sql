SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- F4.6 — Metadados temporais das evidências documentais
-- =====================================================================
-- document_issued_at: data de emissão do documento (quando disponível, nunca inventada)
-- received_at: data/hora em que o Comprova recebeu o documento (armazenamento no object storage)
-- verified_at: data/hora em que a verificação foi concluída (status terminal em evidence_analysis)
-- expires_at: data/hora prevista de expiração = verified_at + 6 meses (política de retenção)

-- 1) evidence_artifact: data de emissão e recebimento do documento original
ALTER TABLE evidence_artifact
  ADD COLUMN document_issued_at timestamptz;

ALTER TABLE evidence_artifact
  ADD COLUMN received_at timestamptz;

-- 2) evidence_analysis: conclusão da verificação e expiração da evidência
ALTER TABLE evidence_analysis
  ADD COLUMN verified_at timestamptz;

ALTER TABLE evidence_analysis
  ADD COLUMN expires_at timestamptz;

-- 3) Índices para consultas por expiração e verificação
CREATE INDEX evidence_analysis_verified_at_idx ON evidence_analysis (verified_at);
CREATE INDEX evidence_analysis_expires_at_idx ON evidence_analysis (expires_at);
CREATE INDEX evidence_artifact_document_issued_at_idx ON evidence_artifact (document_issued_at);
CREATE INDEX evidence_artifact_received_at_idx ON evidence_artifact (received_at);

-- 4) Constraints de integridade
ALTER TABLE evidence_analysis
  ADD CONSTRAINT evidence_analysis_expires_after_verified
    CHECK (expires_at IS NULL OR verified_at IS NULL OR expires_at > verified_at);

-- 5) backfill: registros antigos usam created_at/analyzed_at/retention_until como fallback
--    (sem inventar datas de emissão: document_issued_at fica NULL para registros antigos)
-- Desabilita temporariamente os triggers de imutabilidade para permitir o backfill
ALTER TABLE evidence_artifact DISABLE TRIGGER evidence_artifact_immutable_guard_trg;
ALTER TABLE evidence_analysis DISABLE TRIGGER evidence_analysis_guard_trg;

UPDATE evidence_artifact
SET received_at = created_at
WHERE received_at IS NULL;

UPDATE evidence_analysis
SET verified_at = analyzed_at
WHERE verified_at IS NULL AND analyzed_at IS NOT NULL;

UPDATE evidence_analysis
SET expires_at = (verified_at + interval '6 months')
WHERE expires_at IS NULL AND verified_at IS NOT NULL;

-- Reabilita os triggers
ALTER TABLE evidence_artifact ENABLE TRIGGER evidence_artifact_immutable_guard_trg;
ALTER TABLE evidence_analysis ENABLE TRIGGER evidence_analysis_guard_trg;

-- 6) Comentários documentando os novos campos
COMMENT ON COLUMN evidence_artifact.document_issued_at IS
  'Data de emissão do documento pelo emissor (ex: conta de luz). Opcional: nunca inventada ou inferida.';
COMMENT ON COLUMN evidence_artifact.received_at IS
  'Data/hora em que o Comprova recebeu e armazenou o documento no object storage.';
COMMENT ON COLUMN evidence_analysis.verified_at IS
  'Data/hora em que a verificação do documento foi concluída (status terminal em evidence_analysis).';
COMMENT ON COLUMN evidence_analysis.expires_at IS
  'Data/hora prevista de expiração da evidência = verified_at + 6 meses (política de retenção).';