SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- MÉDIO-3 (auditoria de integridade): garantir no banco a regra
--   "1 claim + 1 signal = 1 claim_evidence".
--
-- Sem esta constraint, retries concorrentes do deep path (ou batch + deep)
-- poderiam duplicar a observação de um mesmo checker para um mesmo claim.
-- A idempotência de runtime cobre o caso sequencial; esta constraint é a
-- última linha de defesa.
--
-- Pré-checagem: não criar a constraint sobre um dataset histórico sujo.
-- Se houver duplicatas, a migration falha de forma explícita (não apaga nada
-- silenciosamente) e o runbook de reconciliação deve ser executado antes.
DO $$
DECLARE
  dup_count bigint;
BEGIN
  SELECT count(*) INTO dup_count
  FROM (
    SELECT 1
    FROM claim_evidence
    WHERE signal_id IS NOT NULL
    GROUP BY claim_id, signal_id
    HAVING count(*) > 1
  ) dup;
  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'claim_evidence possui % combinação(ões) (claim_id, signal_id) duplicada(s); reconcilie antes de aplicar 0024',
      dup_count;
  END IF;
END $$;

-- Índice único parcial: só vale quando há signal associado.
-- Observações sem signal (ex.: artefato material sem signal) não são afetadas.
CREATE UNIQUE INDEX idx_claim_evidence_claim_signal_uq
  ON claim_evidence (claim_id, signal_id)
  WHERE signal_id IS NOT NULL;
