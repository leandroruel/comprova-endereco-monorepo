SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- F5.3 — DID (did:web) para emissores
-- ============================================================================
-- Implementa DID Documents resolvíveis via HTTPS (did:web).
-- Permite rotação de chaves com preservação da verificabilidade.
-- ============================================================================

-- ============================================================================
-- Chaves de assinatura do emissor (já existe em 0031, estendendo)
-- ============================================================================
-- A tabela issuer_signing_key já existe (0031_issuer_signing_key.sql)
-- Adicionamos campos para did:web

ALTER TABLE issuer_signing_key
  ADD COLUMN IF NOT EXISTS did_method text NOT NULL DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS did_identifier text,  -- ex: did:web:comprova.example.com
  ADD COLUMN IF NOT EXISTS controller_did text,  -- DID do controlador (pode ser o mesmo)
  ADD COLUMN IF NOT EXISTS verification_method_id text,  -- ID do método de verificação no DID Document
  ADD COLUMN IF NOT EXISTS verification_relationship text[] DEFAULT ARRAY['assertionMethod'],
  ADD COLUMN IF NOT EXISTS did_document_metadata jsonb DEFAULT '{}';

-- Índice para busca por DID
CREATE INDEX IF NOT EXISTS idx_issuer_signing_key_did
  ON issuer_signing_key (did_identifier) WHERE did_identifier IS NOT NULL;

-- ============================================================================
-- DID Documents (cache/resolução)
-- ============================================================================
CREATE TABLE IF NOT EXISTS did_document (
  did text PRIMARY KEY,  -- ex: did:web:comprova.example.com
  document jsonb NOT NULL,  -- DID Document completo (W3C DID Core)
  -- Metadados de cache
  resolved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- Controle
  etag text,
  content_hash text NOT NULL  -- SHA-256 do documento para detectar mudanças
);

CREATE INDEX IF NOT EXISTS idx_did_document_expires ON did_document (expires_at);

-- ============================================================================
-- Rotação de chaves - histórico
-- ============================================================================
CREATE TABLE IF NOT EXISTS issuer_key_rotation (
  rotation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer_signing_key_id uuid NOT NULL REFERENCES issuer_signing_key (issuer_signing_key_id),
  -- Chave anterior
  previous_key_id uuid REFERENCES issuer_signing_key (issuer_signing_key_id),
  previous_public_key_multibase text NOT NULL,
  -- Nova chave
  new_key_id uuid NOT NULL REFERENCES issuer_signing_key (issuer_signing_key_id),
  new_public_key_multibase text NOT NULL,
  -- Metadados
  reason text, -- 'scheduled', 'compromise', 'policy_change', 'expiration'
  rotated_by text NOT NULL, -- 'system', 'admin:<id>'
  rotated_at timestamptz NOT NULL DEFAULT now(),
  -- DID Document antes/depois
  previous_did_document jsonb,
  new_did_document jsonb
);

CREATE INDEX IF NOT EXISTS idx_issuer_key_rotation_key ON issuer_key_rotation (issuer_signing_key_id);
CREATE INDEX IF NOT EXISTS idx_issuer_key_rotation_at ON issuer_key_rotation (rotated_at);

-- ============================================================================
-- RLS - usando DO blocks para evitar erro de policy já existente
-- ============================================================================
DO $$
BEGIN
  ALTER TABLE did_document ENABLE ROW LEVEL SECURITY;
  ALTER TABLE did_document FORCE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  DROP POLICY IF EXISTS public_read ON did_document;
  CREATE POLICY public_read ON did_document
    USING (true)
    WITH CHECK (false); -- Apenas sistema escreve
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE issuer_key_rotation ENABLE ROW LEVEL SECURITY;
  ALTER TABLE issuer_key_rotation FORCE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  DROP POLICY IF EXISTS tenant_isolation ON issuer_key_rotation;
  CREATE POLICY tenant_isolation ON issuer_key_rotation
    USING (issuer_signing_key_id IN (
      SELECT issuer_signing_key_id FROM issuer_signing_key WHERE tenant_id = app_tenant_id()
    ))
    WITH CHECK (issuer_signing_key_id IN (
      SELECT issuer_signing_key_id FROM issuer_signing_key WHERE tenant_id = app_tenant_id()
    ));
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- ============================================================================
-- Grants
-- ============================================================================
GRANT SELECT ON did_document TO app_user;
GRANT SELECT, INSERT, UPDATE ON issuer_key_rotation TO app_user;

-- ============================================================================
-- Função para gerar DID Document (did:web)
-- ============================================================================
CREATE OR REPLACE FUNCTION generate_did_document(
  p_issuer_signing_key_id uuid,
  p_base_url text  -- ex: 'https://comprova.example.com'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_key RECORD;
  v_did text;
  v_doc jsonb;
  v_verification_method jsonb;
BEGIN
  SELECT * INTO v_key
  FROM issuer_signing_key
  WHERE issuer_signing_key_id = p_issuer_signing_key_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Issuer signing key % not found', p_issuer_signing_key_id;
  END IF;

  -- Extrai domínio do base_url
  -- Ex: https://comprova.example.com -> comprova.example.com
  v_did := 'did:web:' || regexp_replace(p_base_url, '^https?://', '');

  -- Monta verificationMethod
  v_verification_method := jsonb_build_object(
    'id', v_did || '#' || v_key.key_id,
    'type', 'Ed25519VerificationKey2020',
    'controller', v_did,
    'publicKeyMultibase', v_key.public_key_multibase
  );

  -- Monta DID Document (W3C DID Core 1.0)
  v_doc := jsonb_build_object(
    '@context', jsonb_build_array(
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1'
    ),
    'id', v_did,
    'verificationMethod', jsonb_build_array(v_verification_method),
    'assertionMethod', jsonb_build_array(v_did || '#' || v_key.key_id),
    'authentication', jsonb_build_array(v_did || '#' || v_key.key_id),
    'capabilityInvocation', jsonb_build_array(v_did || '#' << v_key.key_id),
    'capabilityDelegation', jsonb_build_array(v_did || '#' || v_key.key_id)
  );

  RETURN v_doc;
END $$;

-- ============================================================================
-- Função para publicar/atualizar DID Document (chamada por worker/cron)
-- ============================================================================
CREATE OR REPLACE FUNCTION publish_did_document(
  p_issuer_signing_key_id uuid,
  p_base_url text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_doc jsonb;
  v_did text;
  v_hash text;
  v_etag text;
BEGIN
  v_doc := generate_did_document(p_issuer_signing_key_id, p_base_url);
  v_did := v_doc->>'id';
  v_hash := encode(digest(v_doc::text, 'sha256'), 'hex');
  v_etag := '"' || v_hash || '"';

  INSERT INTO did_document (did, document, etag, content_hash, expires_at)
  VALUES (v_did, v_doc, v_etag, v_hash, now() + interval '24 hours')
  ON CONFLICT (did) DO UPDATE SET
    document = EXCLUDED.document,
    etag = EXCLUDED.etag,
    content_hash = EXCLUDED.content_hash,
    resolved_at = now(),
    expires_at = now() + interval '24 hours';
END $$;

-- ============================================================================
-- Função para rotacionar chave (cria nova, arquiva antiga)
-- ============================================================================
CREATE OR REPLACE FUNCTION rotate_issuer_key(
  p_issuer_signing_key_id uuid,
  p_new_public_key_multibase text,
  p_new_private_key_pem text,  -- Apenas para armazenamento seguro (KMS/HSM)
  p_rotated_by text,
  p_reason text DEFAULT 'scheduled'
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_old_key RECORD;
  v_new_key_id uuid;
  v_old_doc jsonb;
  v_new_doc jsonb;
  v_base_url text;
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

  -- Publica novo DID Document
  PERFORM publish_did_document(v_new_key_id, 'https://' || replace(v_old_key.did_identifier, 'did:web:', ''));

  RETURN v_new_key_id;
END $$;

-- ============================================================================
-- Grants
-- ============================================================================
GRANT EXECUTE ON FUNCTION generate_did_document TO app_user;
GRANT EXECUTE ON FUNCTION publish_did_document TO app_user;
GRANT EXECUTE ON FUNCTION rotate_issuer_key TO app_user;