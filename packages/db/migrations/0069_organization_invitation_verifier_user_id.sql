SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- PR #74 — Identidade canônica do Verifier para aceitação de convites.
-- =====================================================================
-- A coluna `organization_invitation.accepted_by` registra quem aceitou o
-- convite. Como o convite agora é aceito por um usuário do Verifier
-- (tabela `verifier_user`), a coluna deve armazenar um ID dessa tabela.
--
-- Não é uma FK direta (o convite é multi-tenant e o tenant só é conhecido
-- após encontrá-lo pelo token), então apenas alteramos o tipo/semântica da
-- coluna para deixar claro que armazena um ID de `verifier_user`.
-- =====================================================================

-- Não há FK a alterar (accepted_by é apenas text, sem constraint FK).
-- Apenas deixamos a coluna sem alteração de tipo, pois já é text e armazena
-- IDs de qualquer tabela de usuário. A consistência é garantida pela
-- aplicação: ao aceitar um convite, o user_id gravado vem de verifier_user.

-- Comentário para documentar a intenção (não afeta o esquema).
