SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- Desambiguação `evidence` vs `claim_evidence` (ver ADR-0016).
--
-- Até aqui o PRIMARY KEY de claim_evidence chamava-se `evidence_id`, o que
-- colidia com `evidence.evidence_id` (artefato material em S3) e tornava
-- ambíguo o `signal.evidence_id`. Renomeamos o PK para `claim_evidence_id`.
ALTER TABLE claim_evidence RENAME COLUMN evidence_id TO claim_evidence_id;

-- Vínculo OPCIONAL com artefato material (`evidence`): documento/imagem/snapshot.
-- Nem toda observação possui artefato (ex.: country_check), por isso nullable.
ALTER TABLE claim_evidence
  ADD COLUMN evidence_id uuid REFERENCES evidence (evidence_id);

CREATE INDEX idx_claim_evidence_material
  ON claim_evidence (evidence_id)
  WHERE evidence_id IS NOT NULL;

-- Integridade do alvo do claim: address_id deve existir em canonical_address.
-- (subject_id já possui FK; validation_id fica sem FK porque a PK de validation
--  é particionada por created_at — a exclusão é feita explicitamente.)
ALTER TABLE claim
  ADD CONSTRAINT claim_address_fk
  FOREIGN KEY (address_id) REFERENCES canonical_address (address_id) NOT VALID;

ALTER TABLE claim VALIDATE CONSTRAINT claim_address_fk;
