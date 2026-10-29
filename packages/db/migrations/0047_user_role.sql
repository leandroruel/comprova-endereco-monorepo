SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- F0.X: campo de papel (role) do usuário de autenticação (Better Auth).
-- Default 'user' para não alterar o comportamento de usuários existentes.
-- O valor 'admin' habilita o acesso a rotas administrativas (ex.: debugger
-- do QRCode NF3e). A autorização é feita em nível de aplicação (guard
-- `requireAdmin`), não por scope de API key.
ALTER TABLE "user" ADD COLUMN role text NOT NULL DEFAULT 'user';

-- Permissão de escrita na nova coluna para o papel da aplicação.
GRANT UPDATE (role) ON "user" TO app_user;

CREATE INDEX idx_user_role ON "user" (role);
