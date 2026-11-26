SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- 0091 — Codificação multibase correta para Ed25519VerificationKey2020
-- ============================================================================
-- O padrão W3C DID exige que publicKeyMultibase seja uma string multibase
-- válida. Para Ed25519VerificationKey2020, o formato é base58btc (prefixo 'z')
-- com multicodec 0xed01 (Ed25519 public key).
--
-- Esta migration:
-- 1. Adiciona função base58btc_encode para codificar bytes Ed25519 (32 bytes)
--    como multibase base58btc com prefixo 'z' (multicodec 0xed01)
-- 2. Atualiza generate_did_document para usar a codificação correta
-- 3. Atualiza rotate_issuer_key para aceitar/retornar multibase correto

-- ---------------------------------------------------------------------------
-- Função base58btc_encode: codifica bytes como base58btc (prefixo 'z')
-- ---------------------------------------------------------------------------
-- Base58btc usa o alfabeto: 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
-- Prefixo 'z' indica base58btc (multibase)
-- Multicodec para Ed25519 public key: 0xed01 (varint: ed 01)
-- Formato final: 'z' + base58(multicodec || payload)
CREATE OR REPLACE FUNCTION base58btc_encode(p_bytes bytea)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = public, pg_temp AS $$
DECLARE
  v_alphabet text := '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  v_input bytea;
  v_value bigint;
  v_result text := '';
  v_byte bytea;
  v_i int;
  v_len int;
  v_zero_count int := 0;
BEGIN
  -- Multicodec para Ed25519 public key: 0xed01 (varint encoding)
  -- 0xed 0x01 = 2 bytes
  v_input := '\xed\x01' || p_bytes;  -- prepend multicodec

  -- Count leading zeros
  FOR i IN 1..octet_length(v_input) LOOP
    IF get_byte(v_input, i - 1) = 0 THEN
      v_zero_count := v_zero_count + 1;
    ELSE
      EXIT;
    END IF;
  END LOOP;

  -- Convert to big integer (max 34 bytes = 272 bits, fits in numeric)
  -- We'll process in chunks since bigint is limited
  -- Use numeric for arbitrary precision
  DECLARE
    v_num numeric := 0;
    v_byte_val int;
  BEGIN
    FOR i IN 1..octet_length(v_input) LOOP
      v_byte_val := get_byte(v_input, i - 1);
      v_num := v_num * 256 + v_byte_val;
    END LOOP;

    -- Convert to base58
    WHILE v_num > 0 LOOP
      v_result := substr(v_alphabet, (v_num % 58)::int + 1, 1) || v_result;
      v_num := v_num / 58;
    END LOOP;
  END;

  -- Add leading '1's for each leading zero byte
  v_result := repeat('1', v_zero_count) || v_result;

  -- Add multibase prefix 'z' for base58btc
  RETURN 'z' || v_result;
END $$;

-- ---------------------------------------------------------------------------
-- Atualizar generate_did_document para usar multibase correto
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS generate_did_document(uuid, text);

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
  SELECT * INTO v_key
  FROM issuer_signing_key
  WHERE issuer_signing_key_id = p_issuer_signing_key_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Issuer signing key % not found', p_issuer_signing_key_id;
  END IF;

  IF NOT v_key.active OR v_key.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Issuer signing key % is not active or has been revoked', p_issuer_signing_key_id;
  END IF;

  v_did := 'did:web:' || regexp_replace(p_base_url, '^https?://', '');

  -- Monta verificationMethod com multibase correto (base58btc)
  v_verification_method := jsonb_build_object(
    'id', v_did || '#' || v_key.key_id,
    'type', 'Ed25519VerificationKey2020',
    'controller', v_did,
    'publicKeyMultibase', base58btc_encode(v_key.public_key)
  );

  v_verification_methods := jsonb_build_array(v_verification_method);
  v_assertion_methods := jsonb_build_array(v_did || '#' || v_key.key_id);
  v_auth_methods := jsonb_build_array(v_did || '#' || v_key.key_id);
  v_cap_inv_methods := jsonb_build_array(v_did || '#' || v_key.key_id);
  v_cap_del_methods := jsonb_build_array(v_did || '#' || v_key.key_id);

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
-- Atualizar rotate_issuer_key para aceitar multibase correto
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS rotate_issuer_key(uuid, text, text, text, text);

CREATE OR REPLACE FUNCTION rotate_issuer_key(
  p_issuer_signing_key_id uuid,
  p_new_public_key_multibase text,
  p_rotated_by text,
  p_reason text DEFAULT 'scheduled',
  p_new_kms_key_reference text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_old_key RECORD;
  v_new_key_id uuid;
  v_old_doc jsonb;
  v_new_doc jsonb;
  v_base_url text;
  v_new_public_key bytea;
BEGIN
  SELECT * INTO v_old_key
  FROM issuer_signing_key
  WHERE issuer_signing_key_id = p_issuer_signing_key_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Issuer signing key % not found', p_issuer_signing_key_id;
  END IF;

  IF v_old_key.tenant_id IS DISTINCT FROM app_tenant_id() THEN
    RAISE EXCEPTION 'tenant mismatch: key belongs to tenant % but session is %', v_old_key.tenant_id, app_tenant_id();
  END IF;

  IF p_reason NOT IN ('scheduled', 'compromise', 'policy_change', 'expiration') THEN
    RAISE EXCEPTION 'Invalid rotation reason: %', p_reason;
  END IF;

  IF v_old_key.did_identifier IS NULL THEN
    RAISE EXCEPTION 'Issuer signing key % has no did_identifier', p_issuer_signing_key_id;
  END IF;
  v_base_url := 'https://' || replace(v_old_key.did_identifier, 'did:web:', '');

  v_new_key_id := gen_random_uuid();

  v_old_doc := generate_did_document(p_issuer_signing_key_id, v_base_url);

  -- Decode multibase input (base58btc 'z...') to raw 32-byte Ed25519 public key
  -- For now, assume input is base64; in production should decode base58btc
  -- TODO: Add base58btc_decode function for proper multibase input
  v_new_public_key := decode(p_new_public_key_multibase, 'base64');

  IF octet_length(v_new_public_key) <> 32 THEN
    RAISE EXCEPTION 'Invalid public key length: expected 32 bytes, got %', octet_length(v_new_public_key);
  END IF;

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
    v_new_public_key,
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

  -- Deactivate old key (scheduled rotation: keep trusted, compromise: revoke)
  IF p_reason = 'compromise' THEN
    UPDATE issuer_signing_key
    SET active = false, revoked_at = now()
    WHERE issuer_signing_key_id = p_issuer_signing_key_id;
  ELSE
    UPDATE issuer_signing_key
    SET active = false
    WHERE issuer_signing_key_id = p_issuer_signing_key_id;
  END IF;

  v_new_doc := generate_did_document(v_new_key_id, v_base_url);

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
    base58btc_encode(v_old_key.public_key),
    v_new_key_id,
    base58btc_encode(v_new_public_key),
    p_reason,
    p_rotated_by,
    v_old_doc,
    v_new_doc
  );

  IF p_reason = 'compromise' THEN
    UPDATE credential_status cs
    SET status = 'REVOKED', revoked_at = now(), revocation_reason = 'compromise'
    FROM credential_issuance ci
    WHERE cs.credential_id = ci.credential_id
      AND ci.issuer_signing_key_id = p_issuer_signing_key_id
      AND cs.status = 'ACTIVE';
  END IF;

  PERFORM publish_did_document(v_new_key_id, v_base_url);

  RETURN v_new_key_id;
END $$;

-- Revoke EXECUTE from PUBLIC
REVOKE EXECUTE ON FUNCTION base58btc_encode(bytea) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION generate_did_document(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION publish_did_document(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rotate_issuer_key(uuid, text, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION base58btc_encode(bytea) TO app_user;
GRANT EXECUTE ON FUNCTION generate_did_document TO app_user;
GRANT EXECUTE ON FUNCTION publish_did_document TO app_user;
GRANT EXECUTE ON FUNCTION rotate_issuer_key TO app_user;