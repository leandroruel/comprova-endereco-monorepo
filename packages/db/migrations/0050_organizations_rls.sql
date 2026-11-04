SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- Funções de contexto de sessão usadas pelas políticas RLS das tabelas de
-- organização. `app.tenant_id` é definido por `withTenant()` dentro de cada
-- transação de operação single-tenant. `app.user_id` e `app.user_email` são
-- definidos para leituras multi-tenant legítimas de um usuário autenticado
-- (ex.: listar as organizações às quais ele pertence ou resgatar um convite
-- cujo destinatário é ele), sem expor dados de outras organizações.
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '') $$;

CREATE OR REPLACE FUNCTION app_user_email() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.user_email', true), '') $$;

-- Colunas de dados organizacionais no tenant (a migração 0049 não as incluiu).
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS legal_name text;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS document text;
CREATE INDEX IF NOT EXISTS idx_tenant_document ON tenant (document);

-- RLS em organization_member: isolamento por tenant para gravações e para
-- leitoras dentro de um contexto de tenant. Leitura fora de contexto de
-- tenant só é permitida para as próprias associações do usuário (app.user_id),
-- usada por `listOrganizationsByUser`.
ALTER TABLE organization_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_member FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organization_member_isolation ON organization_member;
CREATE POLICY organization_member_isolation ON organization_member
  USING (tenant_id = app_tenant_id() OR user_id = app_user_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- RLS em organization_invitation: isolamento por tenant para gravações. Leitura
-- fora de contexto de tenant só é permitida para convites endereçados ao e-mail
-- do usuário autenticado (app.user_email), usada por `acceptInvitation` para
-- localizar o convite pelo token antes de saber o tenant.
ALTER TABLE organization_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invitation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organization_invitation_isolation ON organization_invitation;
CREATE POLICY organization_invitation_isolation ON organization_invitation
  USING (tenant_id = app_tenant_id() OR email = app_user_email())
  WITH CHECK (tenant_id = app_tenant_id());

-- Armazena somente o hash do token de convite: o token em texto puro nunca é
-- persistido (é gerado em memória e devolvido uma única vez na criação).
ALTER TABLE organization_invitation DROP COLUMN IF EXISTS token;
ALTER TABLE organization_invitation ADD COLUMN IF NOT EXISTS token_hash text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_organization_invitation_token_hash ON organization_invitation (token_hash);

-- A aplicação precisa inserir/atualizar tenant para criar organizações
-- e completar onboarding.
GRANT INSERT, UPDATE ON tenant TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON organization_member, organization_invitation TO app_user;
