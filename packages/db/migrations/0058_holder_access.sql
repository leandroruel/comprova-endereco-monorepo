SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- F4.2 — acesso do Holder sem conta.
--
-- O Holder interage por token opaco emitido pelo Verifier. Nada aqui cria
-- sessão, dashboard ou conta para o Holder: o token é a única credencial e é
-- resolvido por uma função SECURITY DEFINER restrita.
--
-- Tokens são armazenados como HMAC-SHA-256 (nunca em texto puro). O prefixo é
-- indexado apenas para localizar a linha; a comparação do hash é feita pelo
-- PostgreSQL na própria função, sem trazer o token para a aplicação.

CREATE TABLE holder_access_token (
  token_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  holder_id uuid NOT NULL,
  holder_information_request_id uuid NOT NULL,
  token_prefix text NOT NULL,
  token_hash bytea NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  first_accessed_at timestamptz,
  CONSTRAINT holder_access_token_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (tenant_id),
  CONSTRAINT holder_access_token_holder_tenant_fk
    FOREIGN KEY (holder_id, tenant_id)
    REFERENCES holder (holder_id, tenant_id),
  CONSTRAINT holder_access_token_request_tenant_fk
    FOREIGN KEY (holder_information_request_id, tenant_id)
    REFERENCES holder_information_request (id, tenant_id),
  CONSTRAINT holder_access_token_prefix_check CHECK (char_length(token_prefix) BETWEEN 8 AND 64),
  CONSTRAINT holder_access_token_hash_check CHECK (octet_length(token_hash) = 32),
  CONSTRAINT holder_access_token_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT holder_access_token_prefix_unique UNIQUE (token_prefix)
);
CREATE INDEX idx_holder_access_token_tenant ON holder_access_token (tenant_id);
CREATE INDEX idx_holder_access_token_request ON holder_access_token (tenant_id, holder_information_request_id);
-- Contagem de tokens efetivamente utilizáveis por solicitação (emissão).
CREATE INDEX idx_holder_access_token_active
  ON holder_access_token (holder_information_request_id)
  WHERE revoked_at IS NULL;
GRANT SELECT, INSERT, UPDATE ON holder_access_token TO app_user;
-- Sem DELETE: tokens são revogados, nunca apagados.

ALTER TABLE holder_access_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE holder_access_token FORCE ROW LEVEL SECURITY;
CREATE POLICY holder_access_token_tenant_isolation ON holder_access_token
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- Resposta textual do Holder por item. Sem JSON arbitrário: apenas um valor
-- normalizado (trim) entre 1 e 5000 caracteres.
CREATE TABLE holder_item_response (
  response_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  holder_information_request_id uuid NOT NULL,
  item_id text NOT NULL,
  value text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT holder_item_response_request_tenant_fk
    FOREIGN KEY (holder_information_request_id, tenant_id)
    REFERENCES holder_information_request (id, tenant_id),
  CONSTRAINT holder_item_response_request_item_unique
    UNIQUE (holder_information_request_id, item_id),
  CONSTRAINT holder_item_response_value_length_check
    CHECK (char_length(value) BETWEEN 1 AND 5000),
  CONSTRAINT holder_item_response_value_trimmed_check
    CHECK (value = btrim(value))
);
CREATE INDEX idx_holder_item_response_tenant ON holder_item_response (tenant_id);
CREATE INDEX idx_holder_item_response_request ON holder_item_response (holder_information_request_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON holder_item_response TO app_user;

ALTER TABLE holder_item_response ENABLE ROW LEVEL SECURITY;
ALTER TABLE holder_item_response FORCE ROW LEVEL SECURITY;
CREATE POLICY holder_item_response_tenant_isolation ON holder_item_response
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- Documento enviado pelo Holder.
--
-- `upload_state` separa a intenção (pending) do documento recebido (stored):
-- a linha é commitada ANTES do object storage, então não existe objeto sem
-- registro rastreável. Documento recebido = stored AND deleted_at IS NULL.
-- `deleted_at` é o tombstone usado durante a remoção física.
CREATE TABLE holder_information_request_document (
  document_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  holder_information_request_id uuid NOT NULL,
  item_id text NOT NULL,
  upload_state text NOT NULL,
  storage_key text NOT NULL,
  content_type text,
  size_bytes bigint,
  sha256 bytea,
  original_filename text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT holder_information_request_document_request_tenant_fk
    FOREIGN KEY (holder_information_request_id, tenant_id)
    REFERENCES holder_information_request (id, tenant_id),
  CONSTRAINT holder_information_request_document_storage_key_unique
    UNIQUE (storage_key),
  CONSTRAINT holder_information_request_document_upload_state_check
    CHECK (upload_state IN ('pending', 'stored')),
  CONSTRAINT holder_information_request_document_storage_key_check
    CHECK (storage_key LIKE 'tenants/%/holder-requests/%'),
  CONSTRAINT holder_information_request_document_state_check
    CHECK (
      (upload_state = 'pending'
        AND content_type IS NULL AND size_bytes IS NULL AND sha256 IS NULL AND original_filename IS NULL)
      OR
      (upload_state = 'stored'
        AND content_type IS NOT NULL AND size_bytes IS NOT NULL AND sha256 IS NOT NULL AND original_filename IS NOT NULL)
    ),
  CONSTRAINT holder_information_request_document_sha256_check
    CHECK (sha256 IS NULL OR octet_length(sha256) = 32),
  CONSTRAINT holder_information_request_document_size_check
    CHECK (size_bytes IS NULL OR size_bytes > 0)
);
CREATE INDEX idx_holder_information_request_document_tenant
  ON holder_information_request_document (tenant_id);
CREATE INDEX idx_holder_information_request_document_request
  ON holder_information_request_document (tenant_id, holder_information_request_id);
-- Intenções pendentes: inspeção operacional de objetos potencialmente órfãos.
CREATE INDEX idx_holder_information_request_document_pending
  ON holder_information_request_document (tenant_id, holder_information_request_id, created_at)
  WHERE upload_state = 'pending';
CREATE INDEX idx_holder_information_request_document_item
  ON holder_information_request_document (holder_information_request_id, item_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON holder_information_request_document TO app_user;

ALTER TABLE holder_information_request_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE holder_information_request_document FORCE ROW LEVEL SECURITY;
CREATE POLICY holder_information_request_document_tenant_isolation ON holder_information_request_document
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- ---------------------------------------------------------------------------
-- Resolver de token (pré-tenant, leitura estritamente limitada)
-- ---------------------------------------------------------------------------

-- Role dedicado, sem login e sem memberships. Não usa BYPASSRLS: o acesso é
-- concedido por uma policy específica e apenas na tabela de tokens.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'holder_token_resolver') THEN
    CREATE ROLE holder_token_resolver
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO holder_token_resolver;
GRANT SELECT ON public.holder_access_token TO holder_token_resolver;

CREATE POLICY holder_access_token_resolver_read ON holder_access_token
  FOR SELECT TO holder_token_resolver
  USING (true);

CREATE FUNCTION public.app_resolve_holder_access_token(
  p_prefix text,
  p_token_hash bytea
)
RETURNS TABLE (
  token_id uuid,
  tenant_id uuid,
  holder_id uuid,
  holder_information_request_id uuid,
  first_accessed_at timestamptz
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT
    t.token_id,
    t.tenant_id,
    t.holder_id,
    t.holder_information_request_id,
    t.first_accessed_at
  FROM public.holder_access_token t
  WHERE t.token_prefix = p_prefix
    AND t.token_hash = p_token_hash
    AND t.revoked_at IS NULL
    AND t.expires_at > clock_timestamp()
  LIMIT 1
$$;

-- PostgreSQL exige CREATE no schema para o novo owner durante a transferência.
-- O privilégio é temporário e revogado na mesma transação da migration.
GRANT CREATE ON SCHEMA public TO holder_token_resolver;
ALTER FUNCTION public.app_resolve_holder_access_token(text, bytea)
  OWNER TO holder_token_resolver;
REVOKE CREATE ON SCHEMA public FROM holder_token_resolver;

REVOKE ALL ON FUNCTION public.app_resolve_holder_access_token(text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_resolve_holder_access_token(text, bytea) TO app_user;

-- Assertions: o role termina sem atributos perigosos, sem memberships e sem
-- CREATE no schema. A migration aborta se qualquer invariante for violada.
DO $$
DECLARE
  r record;
  v_direct_create boolean;
BEGIN
  SELECT oid, rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
         rolreplication, rolbypassrls
    INTO r
    FROM pg_roles
   WHERE rolname = 'holder_token_resolver';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'holder_token_resolver role missing';
  END IF;

  IF r.rolcanlogin OR r.rolsuper OR r.rolinherit OR r.rolcreaterole
     OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls THEN
    RAISE EXCEPTION 'holder_token_resolver has unexpected role attributes: %', r;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_auth_members
     WHERE member = r.oid OR roleid = r.oid
  ) THEN
    RAISE EXCEPTION
      'holder_token_resolver must not participate in any role membership (as member or as granted role)';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM pg_namespace n
      CROSS JOIN LATERAL aclexplode(n.nspacl) a
     WHERE n.nspname = 'public'
       AND a.grantee = r.oid
       AND a.privilege_type = 'CREATE'
  ) INTO v_direct_create;

  IF v_direct_create THEN
    RAISE EXCEPTION 'holder_token_resolver retains a direct CREATE grant on schema public';
  END IF;

  IF has_schema_privilege('holder_token_resolver', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'holder_token_resolver has effective CREATE on schema public (check PUBLIC/default ACLs)';
  END IF;
END $$;
