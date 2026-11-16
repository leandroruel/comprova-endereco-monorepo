SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- PR #74 — Identidade canônica do Verifier para memberships de organização.
-- =====================================================================
-- A coluna `organization_member.user_id` referenciava a tabela legada
-- `user` (Better Auth principal, migração 0019). O dashboard do Verifier,
-- por outro lado, autentica na tabela separada `verifier_user` (migração
-- 0056). Como os IDs são de tabelas distintas, um usuário do Verifier nunca
-- conseguia ser membro de organização (403 em toda rota protegida).
--
-- Esta migration altera a FK de `organization_member.user_id` para apontar
-- para `verifier_user.id`, tornando a identidade do Verifier consistente em
-- todo o ciclo: cadastro, login, criação de organização, associação como
-- owner/membro, listagem de organizações, convites, aceite de convites,
-- acesso a rotas protegidas e auditoria.
--
-- Não remove dados existentes: usuários já vinculados como membros mantêm
-- seus `user_id`; somente a constraint de integridade referencial muda. Novas
-- associações deverão usar IDs de `verifier_user`.
-- =====================================================================

-- Remove a FK antiga (nome padrão gerado pelo Postgres: tabela_coluna_fkey).
ALTER TABLE organization_member
  DROP CONSTRAINT IF EXISTS organization_member_user_id_fkey;

-- Adiciona a nova FK para a tabela canônica do Verifier.
ALTER TABLE organization_member
  ADD CONSTRAINT organization_member_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES verifier_user (id)
    ON DELETE CASCADE;

-- Recria o índice existente em user_id (o índice é independente da FK).
DROP INDEX IF EXISTS idx_organization_member_user;
CREATE INDEX idx_organization_member_user ON organization_member (user_id);

-- Mantenha os grants existentes (já concedidos na migration 0049).
