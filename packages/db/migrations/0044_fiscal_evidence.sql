SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- F2.1: observação materializada de fonte fiscal
-- =====================================================================
-- Uma fonte fiscal é um adapter, não um novo modelo de evidência. O resultado
-- normalizado é gravado como UMA linha em `claim_evidence`, com as três
-- dimensões em `detail.verification` e sem `signal`: F2.1 não altera
-- `weightedScore` nem veredito.
--
-- A chave natural inclui `checker_version`, que combina a versão do adapter,
-- a fonte do adapter, o hash estável da referência do documento e a versão do
-- contrato. Resultados transitórios (unavailable/inconclusive/unsupported)
-- recebem um discriminador, para não bloquearem um resultado terminal
-- posterior. Assim:
--   - replay/retry da mesma consulta não duplica;
--   - uma nova versão do adapter cria outra linha e preserva a anterior;
--   - dois documentos diferentes da mesma fonte no mesmo claim não colidem;
--   - unavailable seguido de authentic não é descartado como duplicata.
CREATE UNIQUE INDEX idx_claim_evidence_fiscal_source_uq
  ON claim_evidence (claim_id, source, checker, checker_version)
  WHERE source IN ('fiscal_nf3e', 'fiscal_nfag');

-- Leitura corrente por claim/fonte (auditoria e futuro detalhe público).
CREATE INDEX idx_claim_evidence_fiscal_read_idx
  ON claim_evidence (claim_id, source, observed_at, created_at)
  WHERE source IN ('fiscal_nf3e', 'fiscal_nfag');
