SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- F1.1: intake seguro de comprovante de endereço
-- =====================================================================
-- A operação aceita no máximo UM documento enviado pelo cliente por claim
-- (validation → claim → claim_evidence). A restrição é parcial para não
-- bloquear as demais fontes de evidência (fiscal, registry, street view), que
-- usam `source` diferente. O upload é write-once: uma segunda tentativa com
-- conteúdo diferente é rejeitada e uma repetição idêntica é replay.
--
-- Não há coluna nova, binário no Postgres nem tabela paralela. O objeto
-- continua no ObjectStore privado e a linha em `evidence_artifact`.
CREATE UNIQUE INDEX idx_claim_evidence_customer_document_uq
  ON claim_evidence (claim_id)
  WHERE source = 'customer_submitted_document';
