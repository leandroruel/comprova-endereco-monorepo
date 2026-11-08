SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- Tabelas de auth separadas para admin e verifier, garantindo isolamento
-- total de sessões entre os dois dashboards.

-- Admin auth tables (Better Auth espera nomes `user`, `session`, `account`,
-- `verification`; aqui usamos prefixo `admin_` para isolamento).
CREATE TABLE admin_user (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  role text NOT NULL DEFAULT 'user',
  banned boolean NOT NULL DEFAULT false,
  ban_reason text,
  ban_expires timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_session (
  id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES admin_user(id) ON DELETE CASCADE,
  impersonated_by text
);

CREATE TABLE admin_account (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES admin_user(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Verifier auth tables (mesma estrutura, prefixo `verifier_`).
CREATE TABLE verifier_user (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  role text NOT NULL DEFAULT 'user',
  banned boolean NOT NULL DEFAULT false,
  ban_reason text,
  ban_expires timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verifier_session (
  id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES verifier_user(id) ON DELETE CASCADE,
  impersonated_by text
);

CREATE TABLE verifier_account (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES verifier_user(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verifier_verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_admin_session_user ON admin_session (user_id);
CREATE INDEX idx_admin_account_user ON admin_account (user_id);
CREATE INDEX idx_verifier_session_user ON verifier_session (user_id);
CREATE INDEX idx_verifier_account_user ON verifier_account (user_id);

-- Sincronizar o estado de auth antes da cópia: impedir que novas
-- gravações nas tabelas legacy (user/account/session) ocorram entre a
-- cópia de usuários e a cópia de contas, de modo que o conjunto copiado
-- permaneça consistente e não viole FK de account→user nem deixe
-- credenciais órfãs. Toda a migration roda dentro de uma única
-- transação PostgreSQL (ver packages/db/src/runner.ts), então os locks
-- abaixo persistem até o COMMIT final e bloqueiam writes concorrentes
-- nas tabelas legacy durante o cutover.
LOCK TABLE "user" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "account" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "session" IN SHARE ROW EXCLUSIVE MODE;

-- Provisionar usuários existentes das tabelas legacy nas novas instâncias
-- para que o login continue funcionando após a troca. Preserva o papel
-- (role) de cada usuário.
INSERT INTO admin_user (id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at)
  SELECT id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at
  FROM "user"
  ON CONFLICT (id) DO NOTHING;

INSERT INTO verifier_user (id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at)
  SELECT id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at
  FROM "user"
  ON CONFLICT (id) DO NOTHING;

INSERT INTO admin_account (id, account_id, provider_id, user_id, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at)
  SELECT id, account_id, provider_id, user_id, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at
  FROM "account"
  ON CONFLICT (id) DO NOTHING;

INSERT INTO verifier_account (id, account_id, provider_id, user_id, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at)
  SELECT id, account_id, provider_id, user_id, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at
  FROM "account"
  ON CONFLICT (id) DO NOTHING;

-- Não copiar linhas de "session" para as novas lojas de auth. Sessões
-- legacy não são transferidas: cada usuário deve fazer login novamente
-- no dashboard correspondente (admin ou verifier), gerando sessões
-- novas e independentes nas tabelas admin_session / verifier_session.
-- Isso evita que um token de sessão legado revogado continue válido em
-- qualquer uma das novas instâncias (isolamento total de sessões).

GRANT SELECT, INSERT, UPDATE, DELETE ON admin_user, admin_session, admin_account, admin_verification TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON verifier_user, verifier_session, verifier_account, verifier_verification TO app_user;
