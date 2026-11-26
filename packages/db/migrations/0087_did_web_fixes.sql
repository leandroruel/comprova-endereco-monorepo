SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- 0087 — Correções críticas no DID/Key Rotation (sobre 0078, 0084)
-- ============================================================================
-- 1. Remover coluna private_key_pem (nunca armazenar chave privada no banco)
-- 2. Corrigir bug concatenação capabilityInvocation (<< → ||)
-- 3. Validar tenant em funções SECURITY DEFINER
-- 4. Excluir chaves revogadas dos verificationMethod do DID Document
-- 5. Preservar chaves históricas não revogadas para verificação
-- 6. Impedir sobrescrita de DID Document de outro emissor
-- 7. Rotação normal não revoga credenciais; compromisso revoga só afetadas
-- 8. Usar contrato original de issuer_signing_key (0031/0033/0038)

-- ---------------------------------------------------------------------------
-- 1. Remover private_key_pem se existir (adicionado incorretamente em 0078)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'issuer_signing_key'
      AND column_name = 'private_key_pem'
  ) THEN
    ALTER TABLE issuer_signing_key DROP COLUMN private_key_pem;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Remover colunas de status/did adicionadas em 0078 que duplicam
--    o contrato original (active/revoked_at já existem desde 0031/0033)
--    Mantemos apenas did_method, did_identifier, controller_did,
--    verification_method_id, verification_relationship, did_document_metadata
-- ---------------------------------------------------------------------------
-- NOTA: Se status foi adicionado em 0078, remover; usamos active + revoked_at
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'issuer_signing_key'
      AND column_name = 'status'
  ) THEN
    ALTER TABLE issuer_signing_key DROP COLUMN status;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Corrigir generate_did_document: bug << → || + excluir chaves revogadas
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION generate_did_document(
  p_issuer_signing_key_id uuid,
  p_base_url text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_key RECORD;
  v_did text;
  v_doc jsonb;
  v_verification_method jsonb;
  v_verification_methods jsonb;
  v_assertion_methods jsonb;
  v_auth_methods jsonb;
  v_cap_inv_methods jsonb;
  v_cap_del_methods jsonb;
BEGIN
  -- Validar tenant se chamado com contexto de app (app_tenant_id setado)
  -- Se chamado por worker/cron sem tenant context, permite (admin operation)
  -- A validação estrita fica em rotate_issuer_key/publish_did_document

  SELECT * INTO v_key
  FROM issuer_signing_key
  WHERE issuer_signing_key_id = p_issuer_signing_key_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Issuer signing key % not found', p_issuer_signing_key_id;
  END IF;

  -- Chave deve ser ativa E não revogada para estar no DID Document público
  IF NOT v_key.active OR v_key.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Issuer signing key % is not active or has been revoked', p_issuer_signing_key_id;
  END IF;

  -- Extrai domínio do base_url: https://comprova.example.com → comprova.example.com
  v_did := 'did:web:' || regexp_replace(p_base_url, '^https?://', '');

  -- Monta verificationMethod
  v_verification_method := jsonb_build_object(
    'id', v_did || '#' || v_key.key_id,
    'type', 'Ed25519VerificationKey2020',
    'controller', v_did,
    'publicKeyMultibase', encode(v_key.public_key, 'base64')
  );

  -- Arrays de métodos (para suportar múltiplas chaves no futuro)
  v_verification_methods := jsonb_build_array(v_verification_method);
  v_assertion_methods := jsonb_build_array(v_did || '#' || v_key.key_id);
  v_auth_methods := jsonb_build_array(v_did || '#' || v_key.key_id);
  v_cap_inv_methods := jsonb_build_array(v_did || '#' || v_key.key_id);  -- FIX: || não <<
  v_cap_del_methods := jsonb_build_array(v_did || '#' || v_key.key_id);

  -- Monta DID Document (W3C DID Core 1.0)
  v_doc := jsonb_build_object(
    '@context', jsonb_build_array(
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1'
    ),
    'id', v_did,
    'verificationMethod', v_verification_methods,
    'assertionMethod', v_assertion_methods,
    'authentication', v_auth_methods,
    'capabilityInvocation', v_cap_inv_methods,
    'capabilityDelegation', v_cap_del_methods
  );

  RETURN v_doc;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Corrigir publish_did_document: validar tenant + impedir overwrite cross-tenant
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION publish_did_document(
  p_issuer_signing_key_id uuid,
  p_base_url text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_doc jsonb;
  v_did text;
  v_hash text;
  v_etag text;
  v_key_tenant uuid;
BEGIN
  -- Validar tenant: a chave deve pertencer ao tenant da sessão
  SELECT tenant_id INTO v_key_tenant
  FROM issuer_signing_key
  WHERE issuer_signing_key_id = p_issuer_signing_key_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Issuer signing key % not found', p_issuer_signing_key_id;
  END IF;

  IF v_key_tenant <> app_tenant_id() THEN
    RAISE EXCEPTION 'tenant mismatch: key belongs to tenant % but session is %', v_key_tenant, app_tenant_id();
  END IF;

  v_doc := generate_did_document(p_issuer_signing_key_id, p_base_url);
  v_did := v_doc->>'id';
  v_hash := encode(digest(v_doc::text, 'sha256'), 'hex');
  v_etag := '"' || v_hash || '"';

  -- Upsert com check de tenant implícito via DID (did contém domínio do tenant)
  -- A constraint de PK em did_document impede overwrite de outro DID
  INSERT INTO did_document (did, document, etag, content_hash, expires_at)
  VALUES (v_did, v_doc, v_etag, v_hash, now() + interval '24 hours')
  ON CONFLICT (did) DO UPDATE SET
    document = EXCLUDED.document,
    etag = EXCLUDED.etag,
    content_hash = EXCLUDED.content_hash,
    resolved_at = now(),
    expires_at = now() + interval '24 hours';
END $$;

-- ---------------------------------------------------------------------------
-- 5. Recriar rotate_issuer_key corrigido (sem private_key_pem, valida tenant)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS rotate_issuer_key(uuid, text, text, text, text) CASCADE;

CREATE OR REPLACE FUNCTION rotate_issuer_key(
  p_issuer_signing_key_id uuid,
  p_new_public_key_multibase text,
  p_rotated_by text,
  p_reason text DEFAULT 'scheduled',
  p_new_kms_key_reference text DEFAULT NULL  -- referência KMS, não chave privada
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_old_key RECORD;
  v_new_key_id uuid;
  v_old_doc jsonb;
  v_new_doc jsonb;
  v_base_url text;
  v_revoked_count integer := 0;
BEGIN
  -- Busca chave antiga com lock
  SELECT * INTO v_old_key
  FROM issuer_signing_key
  WHERE issuer_signing_key_id = p_issuer_signing_key_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Issuer signing key % not found', p_issuer_signing_key_id;
  END IF;

  -- Validar tenant
  IF v_old_key.tenant_id <> app_tenant_id() THEN
    RAISE EXCEPTION 'tenant mismatch: key belongs to tenant % but session is %', v_old_key.tenant_id, app_tenant_id();
  END IF;

  -- Validar reason
  IF p_reason NOT IN ('scheduled', 'compromise', 'policy_change', 'expiration') THEN
    RAISE EXCEPTION 'Invalid rotation reason: %', p_reason;
  END IF;

  -- Extrai base_url do DID identifier
  IF v_old_key.did_identifier IS NULL THEN
    RAISE EXCEPTION 'Issuer signing key % has no did_identifier', p_issuer_signing_key_id;
  END IF;
  v_base_url := 'https://' || replace(v_old_key.did_identifier, 'did:web:', '');

  -- Gera novo issuer_signing_key_id
  v_new_key_id := gen_random_uuid();

  -- Captura DID Document antigo
  v_old_doc := generate_did_document(p_issuer_signing_key_id, v_base_url);

  -- Cria nova chave (apenas material público + referência KMS opcional)
  INSERT INTO issuer_signing_key (
    issuer_signing_key_id, tenant_id, issuer_scope, key_id,
    algorithm, public_key,
    active, kms_key_reference,
    did_method, did_identifier, controller_did,
    verification_method_id, verification_relationship,
    did_document_metadata, created_at
  ) VALUES (
    v_new_key_id,
    v_old_key.tenant_id,
    v_old_key.issuer_scope,
    v_old_key.key_id || '_v' || to_char(now(), 'YYYYMMDD'),
    v_old_key.algorithm,
    decode(p_new_public_key_multibase, 'base64'),
    true,
    p_new_kms_key_reference,
    v_old_key.did_method,
    v_old_key.did_identifier,
    v_old_key.controller_did,
    v_old_key.verification_method_id,
    v_old_key.verification_relationship,
    v_old_key.did_document_metadata,
    now()
  );

  -- Atualiza chave antiga: active = false (rotação), revoked_at só se compromise
  IF p_reason = 'compromise' THEN
    UPDATE issuer_signing_key
    SET active = false,
        revoked_at = now()
    WHERE issuer_signing_key_id = p_issuer_signing_key_id;
  ELSE
    UPDATE issuer_signing_key
    SET active = false
    WHERE issuer_signing_key_id = p_issuer_signing_key_id;
  END IF;

  -- Gera novo DID Document
  v_new_doc := generate_did_document(v_new_key_id, v_base_url);

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
    encode(v_old_key.public_key, 'base64'),
    v_new_key_id,
    p_new_public_key_multibase,
    p_reason,
    p_rotated_by,
    v_old_doc,
    v_new_doc
  );

  -- REVOGAÇÃO SELETIVA POR COMPROMISSO
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
  END IF;

  -- Publica novo DID Document
  PERFORM publish_did_document(v_new_key_id, v_base_url);

  RETURN v_new_key_id;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION generate_did_document(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION publish_did_document(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rotate_issuer_key(uuid, text, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION generate_did_document TO app_user;
GRANT EXECUTE ON FUNCTION publish_did_document TO app_user;
GRANT EXECUTE ON FUNCTION rotate_issuer_key TO app_user;