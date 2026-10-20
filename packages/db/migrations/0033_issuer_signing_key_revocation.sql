SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- FASE 16: ciclo de vida da chave de assinatura — revogação/expiração
-- =====================================================================
-- O ADR-0028 deixou explícita uma lacuna: `issuer_signing_key.active = false`
-- significa ROTAÇÃO (a chave deixa de assinar credenciais novas, mas continua
-- publicada para verificar as antigas), não revogação. Uma chave comprometida
-- permanecia autorizada em `assertionMethod` para sempre.
--
-- Esta migration adiciona SOMENTE o instante a partir do qual a chave deixa de
-- ser confiável:
--
--   revoked_at NULL          → chave confiável (publicada/ativa)
--   revoked_at no passado    → revogada (inclusive "expirada")
--   revoked_at no futuro     → expiração agendada; confiável até o instante
--
-- A expiração é o MESMO eixo da revogação: um `revoked_at` futuro é uma
-- revogação agendada. Não há uma segunda coluna (`expires_at`) com semântica
-- sobreposta — o verificador não precisa saber se a parada foi manual ou
-- planejada, só se a chave ainda é confiável em `now()`.
--
-- Consequências de negócio (documentadas no ADR-0029):
--   * a chave revogada/vencida SAI dos documentos públicos (`/issuers/:scope`,
--     `/.well-known/comprova-issuer/:scope` e `/issuers/:scope/did.json`);
--   * uma credencial assinada por ela deixa de resolver a chave (fail closed);
--   * a chave apenas ROTACIONADA (`active = false`) permanece publicada.
--
-- Não se alteram validation/claim/claim_evidence/signal/evidence, scoring,
-- checkers, policy, retenção nem o formato da VC. A chave privada continua fora
-- do banco.

ALTER TABLE issuer_signing_key
  ADD COLUMN revoked_at timestamptz;

COMMENT ON COLUMN issuer_signing_key.revoked_at IS
  'Instante a partir do qual a chave deixa de ser confiável. NULL = confiável; futuro = expiração agendada.';

-- Identidade da linha imutável + revogação monotônica. O app só pode atualizar
-- `revoked_at` (grants por coluna abaixo); o trigger é a barreira contra
-- "desrevogar" ou reescrever a identidade da chave por qualquer papel.
CREATE FUNCTION issuer_signing_key_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.issuer_signing_key_id <> OLD.issuer_signing_key_id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.issuer_scope <> OLD.issuer_scope
     OR NEW.key_id <> OLD.key_id
     OR NEW.algorithm <> OLD.algorithm
     OR NEW.public_key <> OLD.public_key
     OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'issuer_signing_key: identidade é imutável';
  END IF;

  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'issuer_signing_key: revogação é monotônica';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER issuer_signing_key_guard_trg
  BEFORE UPDATE ON issuer_signing_key
  FOR EACH ROW EXECUTE FUNCTION issuer_signing_key_guard();

-- A aplicação revoga (`UPDATE ... SET revoked_at`) sob RLS; o restante da
-- configuração da chave continua sendo operação de admin/seed, que roda com o
-- papel owner. O grant é por COLUNA: o app não consegue reescrever a chave
-- pública, o `key_id` nem a identidade da linha.
GRANT UPDATE (revoked_at) ON issuer_signing_key TO app_user;
