SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- PR #75 — Identidade canônica do Verifier para validation.user_id.
-- =====================================================================
-- A coluna `validation.user_id` referenciava a tabela legada `user`
-- (migração 0019). O dashboard do Verifier autentica na tabela separada
-- `verifier_user` (migração 0056). Como os IDs são de tabelas distintas,
-- a FK antiga permitia armazenar IDs que não existem em `verifier_user`,
-- quebrando a integridade referencial.
--
-- Esta migration altera a FK de `validation.user_id` para apontar para
-- `verifier_user.id`, consistente com a identidade do Verifier.
--
-- Não remove dados existentes: usuários já vinculados como ator de
-- validação mantêm seus `user_id`; somente a constraint de integridade
-- referencial muda. Novas associações deverão usar IDs de `verifier_user`.
-- =====================================================================

-- Remove a FK antiga (nome padrão gerado pelo Postgres: tabela_coluna_fkey).
ALTER TABLE validation
  DROP CONSTRAINT IF EXISTS validation_user_id_fkey;

-- Adiciona a nova FK para a tabela canônica do Verifier.
ALTER TABLE validation
  ADD CONSTRAINT validation_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES verifier_user (id)
    ON DELETE CASCADE;

-- Recria o índice existente em user_id (o índice é independente da FK).
DROP INDEX IF EXISTS idx_validation_user;
CREATE INDEX idx_validation_user ON validation (user_id, created_at DESC) WHERE user_id IS NOT NULL;

-- Mantenha os grants existentes (já concedidos na migration 0020).
