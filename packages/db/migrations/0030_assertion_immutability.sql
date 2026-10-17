SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- Revisão crítica de 0028 (revisão do modelo para futura camada SSI/VC).
--
-- 0028 já protegia a observação (`claim_evidence`) e a identidade/autoridade/
-- policy da `validation`, mas deixou dois buracos no GRAFO DA ASSERÇÃO:
--
--   (1) `claim` — a asserção propriamente dita ("este issuer afirma X sobre este
--       subject") — não tinha nenhuma proteção: um UPDATE silencioso poderia
--       trocar `type`, `subject_id` ou `address_id` e dessincronizar a asserção
--       do conjunto de evidências que a sustenta.
--   (2) `validation.validation_id` (o identificador da asserção) e
--       `validation.legal_basis` (a base legal sob a qual ela é feita) ficaram
--       fora do guard de identidade.
--
-- Nenhum caminho de produção faz UPDATE em `claim` nem em `validation_id`/
-- `legal_basis` (verificado por busca no código). Portanto estas travas são
-- defensivas e NÃO alteram comportamento: preservam exatamente a semântica
-- atual. DELETE NÃO é bloqueado — continua sendo a operação legítima da
-- retenção (ADR de retenção) e do direito de eliminação (LGPD).
--
-- NÃO se alteram scoring, checkers, policy semântica, thresholds, building_key,
-- unit_key, o pipeline T0/T1/T2 nem a política de retenção.

-- =====================================================================
-- (1) Validation: completar a identidade imutável
-- =====================================================================
-- Mesma função de 0028, agora também imutável em:
--   validation_id  → identificador da asserção (idempotência/claim apontam p/ ele)
--   legal_basis    → autoridade/base legal da asserção
-- O trigger `validation_identity_guard_trg` (0028) passa a usar esta versão.
CREATE OR REPLACE FUNCTION validation_identity_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.validation_id <> OLD.validation_id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.subject_id <> OLD.subject_id
     OR NEW.api_key_id IS DISTINCT FROM OLD.api_key_id
     OR NEW.issuer_scopes IS DISTINCT FROM OLD.issuer_scopes
     OR NEW.policy_version <> OLD.policy_version
     OR NEW.policy_hash IS DISTINCT FROM OLD.policy_hash
     OR NEW.scorer_version IS DISTINCT FROM OLD.scorer_version
     OR NEW.legal_basis <> OLD.legal_basis
     OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION
      'validation: identidade/autoridade/policy são imutáveis após a criação';
  END IF;
  RETURN NEW;
END $$;

-- =====================================================================
-- (2) Claim: a asserção é imutável (UPDATE; DELETE permanece permitido)
-- =====================================================================
-- A observação (`claim_evidence`) já era imutável (0028). O seu pai — a
-- asserção — passa a ter a mesma garantia, para que `validation → claim →
-- claim_evidence` seja um grafo append-only (fora da evolução de ciclo de vida
-- da validation e da retenção/LGPD).
CREATE OR REPLACE FUNCTION claim_immutability_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.claim_id <> OLD.claim_id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.validation_id <> OLD.validation_id
     OR NEW.subject_id <> OLD.subject_id
     OR NEW.address_id IS DISTINCT FROM OLD.address_id
     OR NEW.type <> OLD.type
     OR NEW.subject_type <> OLD.subject_type
     OR NEW.target_type <> OLD.target_type
     OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'claim é imutável: a asserção não pode ser reescrita';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER claim_immutability_guard_trg
  BEFORE UPDATE ON claim
  FOR EACH ROW EXECUTE FUNCTION claim_immutability_guard();
