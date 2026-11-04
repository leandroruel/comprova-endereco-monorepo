SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- Tabela de organizações Verifier. Reusa a raiz de tenancy (`tenant`) como
-- identificador da organização: um tenant pode ser do tipo 'organization'
-- (cliente Verifier com onboarding) ou 'technical' (infraestrutura interna).
-- Não existe tabela `organization` separada para evitar duplicar a raiz de
-- tenancy e o isolamento RLS já existente.
ALTER TABLE tenant ADD COLUMN type text NOT NULL DEFAULT 'technical';
ALTER TABLE tenant ADD COLUMN onboarding_status text NOT NULL DEFAULT 'completed';
ALTER TABLE tenant ADD COLUMN terms_accepted_at timestamptz;
ALTER TABLE tenant ADD COLUMN terms_accepted_by text;
ALTER TABLE tenant ADD COLUMN terms_version text;

-- Constraint de valores válidos para `type` e `onboarding_status`.
ALTER TABLE tenant ADD CONSTRAINT tenant_type_check CHECK (type IN ('technical', 'organization'));
ALTER TABLE tenant ADD CONSTRAINT tenant_onboarding_status_check CHECK (onboarding_status IN ('pending', 'completed', 'suspended'));

-- Índices para consultas frequentes por tipo/status.
CREATE INDEX idx_tenant_type ON tenant (type);
CREATE INDEX idx_tenant_onboarding_status ON tenant (onboarding_status);

-- Associação explícita usuário ↔ organização (tenant do tipo 'organization').
-- Um usuário pode pertencer a múltiplas organizações; uma organização pode
-- ter múltiplos membros. O usuário que cria a organização vira 'owner'.
CREATE TABLE organization_member (
  organization_member_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT now(),
  invited_by text, -- user_id do convidante (opcional, para auditoria)
  CONSTRAINT organization_member_role_check CHECK (role IN ('owner', 'admin', 'member')),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX idx_organization_member_tenant ON organization_member (tenant_id);
CREATE INDEX idx_organization_member_user ON organization_member (user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON organization_member TO app_user;

-- A aplicação precisa inserir/atualizar tenant para criar organizações
-- e completar onboarding.
GRANT INSERT, UPDATE ON tenant TO app_user;

-- Convites de organização: email + token de uso único, expiração e aceite.
-- Usado no fluxo de onboarding: o administrador convida um membro por email;
-- o token é enviado (fora de escopo desta fase) e resgatado no cadastro.
CREATE TABLE organization_invitation (
  organization_invitation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  email text NOT NULL,
  token text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'member',
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by text, -- user_id que aceitou o convite
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_invitation_role_check CHECK (role IN ('owner', 'admin', 'member')),
  CONSTRAINT organization_invitation_email_check CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
);
CREATE INDEX idx_organization_invitation_tenant ON organization_invitation (tenant_id);
CREATE INDEX idx_organization_invitation_token ON organization_invitation (token);
CREATE INDEX idx_organization_invitation_email ON organization_invitation (email);
GRANT SELECT, INSERT, UPDATE, DELETE ON organization_invitation TO app_user;

-- Tipo de API key: 'user' (usuário autenticado, default) ou 'm2m' (máquina a máquina,
-- sem sessão de usuário, autenticação por bearer token puro).
ALTER TABLE api_key ADD COLUMN key_type text NOT NULL DEFAULT 'user';
ALTER TABLE api_key ADD CONSTRAINT api_key_key_type_check CHECK (key_type IN ('user', 'm2m'));

-- A aplicação precisa gerenciar credenciais de API.
GRANT SELECT, INSERT, UPDATE, DELETE ON api_key TO app_user;

-- Novo escopo para operações M2M de verificação.
-- `verify:m2m` permite usar a API para operações de verificação sem sessão
-- de usuário do dashboard. Concedido apenas a chaves `key_type = 'm2m'`.
-- O default continua `validate:read,validate:write`; `verify:m2m` é opt-in.

-- Comentário de documentação (não afeta o esquema):
-- COMMENT ON COLUMN tenant.type IS 'technical (infra) ou organization (cliente Verifier)';
-- COMMENT ON COLUMN tenant.onboarding_status IS 'pendente, concluído ou suspenso';
-- COMMENT ON COLUMN api_key.key_type IS 'user (com sessão) ou m2m (máquina a máquina)';
