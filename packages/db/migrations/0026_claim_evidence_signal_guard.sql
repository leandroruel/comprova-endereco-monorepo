SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- MÉDIO-4 (auditoria de integridade): impedir no banco que
--   claim_evidence de um claim aponte para um `signal` de OUTRA validation/tenant.
--
-- Por que não uma FK: `signal` é particionada por created_at com PK
-- (signal_id, created_at); o PostgreSQL exige que índices únicos em tabelas
-- particionadas incluam a coluna de particionamento, então NÃO é possível criar
-- UNIQUE(signal_id) nem FK claim_evidence.signal_id -> signal.
--
-- Solução: CONSTRAINT TRIGGER DEFERRABLE. Ele roda no COMMIT (não no momento do
-- INSERT), o que é essencial porque o fast path insere `claim_evidence` ANTES de
-- `signal` na mesma transação. Ao final da transação, ambos já existem.
--
-- Invariante protegida: signal.validation_id = claim.validation_id do claim
-- referenciado (e, por consequência, mesmo tenant, já que a RLS/RLS-composite
-- garante a coerência do claim).

CREATE OR REPLACE FUNCTION claim_evidence_signal_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_claim_validation uuid;
  v_claim_tenant     uuid;
  v_signal_validation uuid;
BEGIN
  -- Observação sem signal (ex.: artefato material sem signal) não é afetada.
  IF NEW.signal_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT c.validation_id, c.tenant_id
    INTO v_claim_validation, v_claim_tenant
    FROM claim c
   WHERE c.claim_id = NEW.claim_id;

  IF v_claim_validation IS NULL THEN
    RAISE EXCEPTION 'claim_evidence.claim_id % inexistente', NEW.claim_id;
  END IF;

  SELECT s.validation_id
    INTO v_signal_validation
    FROM signal s
   WHERE s.signal_id = NEW.signal_id
   LIMIT 1;

  IF v_signal_validation IS NULL THEN
    RAISE EXCEPTION
      'claim_evidence.signal_id % não corresponde a nenhum signal', NEW.signal_id;
  END IF;

  IF v_signal_validation <> v_claim_validation THEN
    RAISE EXCEPTION
      'claim_evidence.signal_id % pertence à validation %, mas o claim pertence à validation %',
      NEW.signal_id, v_signal_validation, v_claim_validation;
  END IF;

  IF NEW.tenant_id <> v_claim_tenant THEN
    RAISE EXCEPTION
      'claim_evidence.tenant_id % difere do tenant do claim %', NEW.tenant_id, v_claim_tenant;
  END IF;

  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER claim_evidence_signal_guard_trg
  AFTER INSERT OR UPDATE ON claim_evidence
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION claim_evidence_signal_guard();
