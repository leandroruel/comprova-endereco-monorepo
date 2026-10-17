SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- V-1..V-5 (auditoria de verificabilidade): bindings de domínio necessários
-- para que uma validation possa, no futuro, virar uma credencial verificável,
-- SEM implementar DID/VC/SSI e SEM alterar scoring/checkers/policy/building_key.
--
-- Nada é apagado; nenhum backfill destrutivo. Todos os campos novos são
-- NULLABLE para os registros históricos (ver ADR-0017 §compatibilidade).

-- =====================================================================
-- V-1 — issuer / autoridade da validation
-- =====================================================================
-- `validation.api_key_id` referencia a credencial que originou a asserção.
-- Coerência de tenant garantida por FK COMPOSTA (api_key_id, tenant_id),
-- mesma estratégia de `claim -> subject` (0025): impede
--   validation.tenant_id = A  +  api_key de B.
-- Requer chave única de apoio em api_key (api_key_id já é PK).

CREATE UNIQUE INDEX api_key_id_tenant_uq ON api_key (api_key_id, tenant_id);
ALTER TABLE api_key
  ADD CONSTRAINT api_key_id_tenant_uq UNIQUE USING INDEX api_key_id_tenant_uq;

ALTER TABLE validation ADD COLUMN api_key_id uuid;
-- Snapshot da autoridade efetiva no momento da emissão (imutável depois).
ALTER TABLE validation ADD COLUMN issuer_scopes text[];

-- =====================================================================
-- V-5 / §8 / §9 — policy, scorer e evidence-set
-- =====================================================================
-- `policy_hash` = digest do conteúdo efetivo do YAML de policy carregado.
-- `scorer_version` = versão da implementação que produziu verdict/score.
-- `evidence_set_hash` = digest determinístico do conjunto de observações.
ALTER TABLE validation ADD COLUMN policy_hash text;
ALTER TABLE validation ADD COLUMN scorer_version text;
ALTER TABLE validation ADD COLUMN evidence_set_hash text;

-- FK composta: valida existência E coerência de tenant.
-- OBS: o PostgreSQL NÃO suporta `NOT VALID` em FK de tabela particionada
-- ("This feature is not yet supported on partitioned tables"), então a FK é
-- criada já validada. Registros históricos têm `api_key_id IS NULL` e, sob
-- MATCH SIMPLE (default), a FK é satisfeita — sem inventar credencial.
ALTER TABLE validation
  ADD CONSTRAINT validation_api_key_tenant_fk
  FOREIGN KEY (api_key_id, tenant_id) REFERENCES api_key (api_key_id, tenant_id);

CREATE INDEX idx_validation_api_key
  ON validation (api_key_id, created_at DESC)
  WHERE api_key_id IS NOT NULL;

-- =====================================================================
-- V-3 — binding criptográfico durável da evidência material
-- =====================================================================
-- `evidence_id` é o ponteiro efêmero para o artefato (pode virar NULL na
-- retenção). `evidence_sha256` é o digest DURÁVEL, preservado após a retenção.
-- Tipo consistente com `evidence.sha256` (bytea). Nullable: há observações
-- sem material.
ALTER TABLE claim_evidence ADD COLUMN evidence_sha256 bytea;

-- =====================================================================
-- V-5 (§5) — consistência do digest material (runtime + garantia relacional)
-- =====================================================================
-- Quando evidence_id existe, evidence_sha256 DEVE ser igual a evidence.sha256.
-- (evidence é global / sem RLS, então o SELECT no trigger é livre.)
CREATE OR REPLACE FUNCTION claim_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_sha bytea;
BEGIN
  -- (1) Binding do digest material (INSERT e UPDATE).
  IF NEW.evidence_id IS NOT NULL THEN
    SELECT sha256 INTO v_sha FROM evidence WHERE evidence_id = NEW.evidence_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'claim_evidence.evidence_id % não corresponde a nenhum evidence', NEW.evidence_id;
    END IF;
    IF NEW.evidence_sha256 IS NULL THEN
      RAISE EXCEPTION
        'claim_evidence.evidence_sha256 é obrigatório quando evidence_id está definido (evidence_id %)',
        NEW.evidence_id;
    END IF;
    IF NEW.evidence_sha256 <> v_sha THEN
      RAISE EXCEPTION
        'claim_evidence.evidence_sha256 não corresponde a evidence.sha256 (evidence_id %)',
        NEW.evidence_id;
    END IF;
  END IF;

  -- (2) Imutabilidade da observação (somente UPDATE).
  -- A ÚNICA transição permitida é a desvinculação do material expirado:
  --   evidence_id X -> NULL   (política de retenção já implementada).
  -- evidence_sha256 NÃO é apagado nessa transição.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.claim_evidence_id <> OLD.claim_evidence_id
       OR NEW.tenant_id <> OLD.tenant_id
       OR NEW.claim_id <> OLD.claim_id
       OR NEW.signal_id IS DISTINCT FROM OLD.signal_id
       OR NEW.checker <> OLD.checker
       OR NEW.checker_version <> OLD.checker_version
       OR NEW.stance <> OLD.stance
       OR NEW.strength IS DISTINCT FROM OLD.strength
       OR NEW.confidence IS DISTINCT FROM OLD.confidence
       OR NEW.source <> OLD.source
       OR NEW.observed_at <> OLD.observed_at
       OR NEW.ttl_seconds <> OLD.ttl_seconds
       OR NEW.expires_at <> OLD.expires_at
       OR NEW.detail IS DISTINCT FROM OLD.detail
       OR NEW.evidence_sha256 IS DISTINCT FROM OLD.evidence_sha256
       OR NEW.created_at <> OLD.created_at
    THEN
      RAISE EXCEPTION
        'claim_evidence é imutável: apenas evidence_id pode transicionar para NULL';
    END IF;

    IF NEW.evidence_id IS DISTINCT FROM OLD.evidence_id AND NEW.evidence_id IS NOT NULL THEN
      RAISE EXCEPTION
        'claim_evidence.evidence_id só pode ser anulado (transição X -> NULL)';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER claim_evidence_guard_trg
  BEFORE INSERT OR UPDATE ON claim_evidence
  FOR EACH ROW EXECUTE FUNCTION claim_evidence_guard();

-- =====================================================================
-- §3 / §12 — imutabilidade da identidade/policy da validation
-- =====================================================================
-- issuer, snapshot de autoridade, policy e scorer NÃO podem mudar depois da
-- criação (replay/deep não os reescrevem). A evolução legítima do ciclo de
-- vida (status/verdict/score/confidence/explanation/completed_at/
-- evidence_set_hash/workflow_id) permanece livre.
CREATE OR REPLACE FUNCTION validation_identity_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
     OR NEW.subject_id <> OLD.subject_id
     OR NEW.api_key_id IS DISTINCT FROM OLD.api_key_id
     OR NEW.issuer_scopes IS DISTINCT FROM OLD.issuer_scopes
     OR NEW.policy_version <> OLD.policy_version
     OR NEW.policy_hash IS DISTINCT FROM OLD.policy_hash
     OR NEW.scorer_version IS DISTINCT FROM OLD.scorer_version
     OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION
      'validation: identidade/autoridade/policy são imutáveis após a criação';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER validation_identity_guard_trg
  BEFORE UPDATE ON validation
  FOR EACH ROW EXECUTE FUNCTION validation_identity_guard();
