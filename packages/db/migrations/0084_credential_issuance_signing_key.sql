SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- 0084 — Rastrear chave de assinatura na emissão + revogação por compromisso
-- ============================================================================
-- Para implementar revogação seletiva por comprometimento de chave, precisamos
-- saber QUAL chave assinou cada credencial. Esta migration:
-- 1. Adiciona `issuer_signing_key_id` a `credential_issuance` (FK opcional)
-- 2. Atualiza `rotate_issuer_key` para revogar credenciais da chave antiga
--    APENAS quando `p_reason = 'compromise'`. Rotação normal ('scheduled',
--    'policy_change', 'expiration') NÃO revoga.

-- ---------------------------------------------------------------------------
-- 1. Coluna FK em credential_issuance (opcional: emissões antigas ficam NULL)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'credential_issuance') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'credential_issuance' AND column_name = 'issuer_signing_key_id') THEN
      ALTER TABLE credential_issuance
        ADD COLUMN issuer_signing_key_id uuid REFERENCES issuer_signing_key (issuer_signing_key_id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS credential_issuance_signing_key_idx ON credential_issuance (issuer_signing_key_id);

-- ---------------------------------------------------------------------------
-- 2. Atualizar rotate_issuer_key para revogar em caso de compromisso
-- ---------------------------------------------------------------------------
-- A função já existe; aqui recriamos com a lógica de revogação seletiva.
-- Mantemos o mesmo signature e grants.
CREATE OR REPLACE FUNCTION rotate_issuer_key(
  p_issuer_signing_key_id uuid,
  p_new_public_key_multibase text,
  p_new_private_key_pem text,
  p_rotated_by text,
  p_reason text DEFAULT 'scheduled'
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_old_key RECORD;
  v_new_key_id uuid;
  v_old_doc jsonb;
  v_new_doc jsonb;
  v_base_url text;
  v_revoked_count integer := 0;
BEGIN
  -- Busca chave antiga
  SELECT * INTO v_old_key
  FROM issuer_signing_key
  WHERE issuer_signing_key_id = p_issuer_signing_key_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Issuer signing key % not found', p_issuer_signing_key_id;
  END IF;

  -- Extrai base_url do DID identifier
  v_base_url := 'https://' || replace(v_old_key.did_identifier, 'did:web:', '');

  -- Gera novo key_id
  v_new_key_id := gen_random_uuid();

  -- Captura DID Document antigo
  v_old_doc := generate_did_document(p_issuer_signing_key_id, 'https://' || replace(v_old_key.did_identifier, 'did:web:', ''));

  -- Cria nova chave
  INSERT INTO issuer_signing_key (
    issuer_signing_key_id, tenant_id, key_id,
    public_key_multibase, private_key_pem,
    algorithm, status,
    did_method, did_identifier, controller_did,
    verification_method_id, verification_relationship,
    did_document_metadata, created_at
  ) VALUES (
    v_new_key_id,
    v_old_key.tenant_id,
    v_old_key.key_id || '_v' || to_char(now(), 'YYYYMMDD'),
    p_new_public_key_multibase,
    p_new_private_key_pem,
    v_old_key.algorithm,
    'active',
    v_old_key.did_method,
    v_old_key.did_identifier,
    v_old_key.controller_did,
    v_old_key.verification_method_id,
    v_old_key.verification_relationship,
    v_old_key.did_document_metadata,
    now()
  );

  -- Atualiza chave antiga para 'rotated'
  UPDATE issuer_signing_key
  SET status = 'rotated',
      revoked_at = now()
  WHERE issuer_signing_key_id = p_issuer_signing_key_id;

  -- Gera novo DID Document
  v_new_doc := generate_did_document(v_new_key_id, 'https://' || replace(v_old_key.did_identifier, 'did:web:', ''));

  -- Registra rotação
  INSERT INTO issuer_key_rotation (
    issuer_signing_key_id,
    previous_key_id,
    previous_public_key_multibase,
    new_key_id,
    new_public_key_multibase,
    reason,
    rotated_by,
    previous_did_document,
    new_did_document
  ) VALUES (
    v_new_key_id,
    p_issuer_signing_key_id,
    v_old_key.public_key_multibase,
    v_new_key_id,
    p_new_public_key_multibase,
    p_reason,
    p_rotated_by,
    v_old_doc,
    v_new_doc
  );

  -- REVOGAÇÃO SELETIVA POR COMPROMISSO
  -- Se a rotação foi por 'compromise', revoga TODAS as credenciais assinadas
  -- pela chave comprometida. Rotação normal NÃO revoga.
  IF p_reason = 'compromise' THEN
    UPDATE credential_status cs
    SET status = 'REVOKED',
        revoked_at = now(),
        revocation_reason = 'compromise'
    FROM credential_issuance ci
    WHERE cs.credential_id = ci.credential_id
      AND ci.issuer_signing_key_id = p_issuer_signing_key_id
      AND cs.status = 'ACTIVE';

    GET DIAGNOSTICS v_revoked_count = ROW_COUNT;

    -- Log da revogação (pode ser lido via issuer_key_rotation ou audit_log)
    -- O campo revocation_reason='compromise' distingue de revogação manual/superseded.
  END IF;

  -- Publica novo DID Document
  PERFORM publish_did_document(v_new_key_id, 'https://' || replace(v_old_key.did_identifier, 'did:web:', ''));

  RETURN v_new_key_id;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Grant (já existe em 0078, mas reafirmamos para idempotência)
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION rotate_issuer_key TO app_user;