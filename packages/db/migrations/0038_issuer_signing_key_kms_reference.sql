SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- FASE 17: backend de assinatura externo (AWS KMS) — referência da chave
-- =====================================================================
-- A chave privada continua FORA do banco. Para uma chave cujo material vive no
-- AWS KMS, `issuer_signing_key` precisa apenas apontar para a chave externa:
-- qual chave lógica do projeto (tenant + key_id, com a pública publicada) é
-- assinada por qual chave do KMS.
--
--   kms_key_reference NULL  → material local em CREDENTIAL_SIGNING_KEYS
--   kms_key_reference '...' → chave Ed25519 no AWS KMS (ARN canônico)
--
-- O valor é uma REFERÊNCIA, nunca material privado. O ARN é gravado no
-- provisionamento a partir do `KeyId` retornado pelo `GetPublicKey` (e não um
-- alias, que poderia ser repontado depois) e o trigger abaixo o torna imutável,
-- como os demais campos de identidade da chave.
--
-- O banco continua sendo a autoridade do lifecycle (`active`/`revoked_at`); o
-- KMS apenas executa a assinatura da chave já selecionada. A verificação
-- pública continua usando a coluna `public_key`, sem consultar a AWS.
--
-- Não se alteram validation/claim/claim_evidence/signal/evidence, scoring,
-- checkers, policy, retenção nem o formato da VC.

ALTER TABLE issuer_signing_key
  ADD COLUMN kms_key_reference text;

COMMENT ON COLUMN issuer_signing_key.kms_key_reference IS
  'Referência da chave no backend externo de assinatura (ARN/ID do AWS KMS). NULL = material local em CREDENTIAL_SIGNING_KEYS. Não contém material privado.';

ALTER TABLE issuer_signing_key
  ADD CONSTRAINT issuer_signing_key_kms_reference_nonempty
  CHECK (kms_key_reference IS NULL OR length(btrim(kms_key_reference)) > 0);

-- Identidade da linha imutável + revogação monotônica (migration 0033). A
-- referência externa entra na identidade: trocá-la mudaria qual chave do KMS
-- assina, mantendo a mesma pública publicada — uma substituição silenciosa.
CREATE OR REPLACE FUNCTION issuer_signing_key_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.issuer_signing_key_id <> OLD.issuer_signing_key_id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.issuer_scope <> OLD.issuer_scope
     OR NEW.key_id <> OLD.key_id
     OR NEW.algorithm <> OLD.algorithm
     OR NEW.public_key <> OLD.public_key
     OR NEW.created_at <> OLD.created_at
     OR NEW.kms_key_reference IS DISTINCT FROM OLD.kms_key_reference
  THEN
    RAISE EXCEPTION 'issuer_signing_key: identidade é imutável';
  END IF;

  -- Monotonicidade = a confiança só pode ENCOLHER. Um `revoked_at` futuro pode
  -- ser antecipado (revogação de emergência de uma expiração agendada), mas
  -- nunca adiado nem desfeito (NULL): ambos estenderiam a confiança.
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at IS NULL OR NEW.revoked_at > OLD.revoked_at) THEN
    RAISE EXCEPTION 'issuer_signing_key: revogação é monotônica';
  END IF;

  RETURN NEW;
END $$;
