SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- F1.3: materialização da verificação do documento enviado
-- =====================================================================
-- A observação do intake F1.1 (`source = customer_submitted_document`) é
-- imutável e continua sendo o recibo do upload. A verificação é uma observação
-- DISTINTA (`source = uploaded_document`), com as três dimensões no `detail`.
--
-- A chave natural é (claim, checker, checker_version), onde a versão inclui a
-- política de comparação + analyzer_version + contract_version. Assim:
--   - replay/retry da mesma versão não duplica;
--   - uma nova versão cria outra linha e preserva a anterior;
--   - não há `signal` associado, então o score não muda.
CREATE UNIQUE INDEX idx_claim_evidence_uploaded_verification_uq
  ON claim_evidence (claim_id, checker, checker_version)
  WHERE source = 'uploaded_document';

-- Leitura corrente do GET: verificação mais recente do claim. A ordenação é
-- resolvida pelo índice; o desempate é `created_at`.
CREATE INDEX idx_claim_evidence_uploaded_verification_read_idx
  ON claim_evidence (claim_id, observed_at, created_at)
  WHERE source = 'uploaded_document';
