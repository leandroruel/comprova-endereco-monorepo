SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- PR #75 — Reconciliação de identidade e preservação de histórico.
-- =====================================================================
-- As migrations 0068, 0070 e 0071 alteram as FKs de organization_member,
-- batch e validation para apontar para verifier_user.id, mas usam
-- ON DELETE CASCADE, o que apaga registros históricos quando um usuário
-- Verifier é excluído.
--
-- Além disso, como a migration 0056 copiou usuários da tabela legada `user`
-- para verifier_user no momento de sua execução, podem existir registros em
-- organization_member, batch e validation que referenciam IDs da tabela
-- legada que não existem em verifier_user. Adicionar a nova FK com
-- RESTRICT falharia se houvesse registros órfãos.
--
-- Esta migration:
-- 1. Verifica se existem registros órfãos (user_id não existente em
--    verifier_user) em organization_member, batch e validation. Se houver,
--    interrompe com erro explícito, sem perda de dados.
-- 2. Altera as FKs existentes de ON DELETE CASCADE para ON DELETE RESTRICT,
--    impedindo a exclusão de um usuário Verifier enquanto houver
--    referências históricas (validações, lotes, membros de organização).
-- =====================================================================

DO $$
DECLARE
  org_member_orphans int;
  batch_orphans int;
  validation_orphans int;
  msg text;
BEGIN
  -- Verifica registros órfãos em organization_member.user_id
  SELECT count(*) INTO org_member_orphans
  FROM organization_member om
  WHERE om.user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM verifier_user vu WHERE vu.id = om.user_id
    );

  -- Verifica registros órfãos em batch.user_id
  SELECT count(*) INTO batch_orphans
  FROM batch b
  WHERE b.user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM verifier_user vu WHERE vu.id = b.user_id
    );

  -- Verifica registros órfãos em validation.user_id
  SELECT count(*) INTO validation_orphans
  FROM validation v
  WHERE v.user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM verifier_user vu WHERE vu.id = v.user_id
    );

  IF org_member_orphans > 0 OR batch_orphans > 0 OR validation_orphans > 0 THEN
    msg := format(
      'PR #75: registros órfãos encontrados — não é possível aplicar FK para verifier_user. '
      'organization_member: %s órfão(s), batch: %s órfão(s), validation: %s órfão(s). '
      'Reconcilie os registros antes de aplicar esta migration.',
      org_member_orphans, batch_orphans, validation_orphans
    );
    RAISE EXCEPTION '%', msg;
  END IF;
END $$;

-- Altera FK de organization_member.user_id para ON DELETE RESTRICT
ALTER TABLE organization_member
  DROP CONSTRAINT IF EXISTS organization_member_user_id_fkey;

ALTER TABLE organization_member
  ADD CONSTRAINT organization_member_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES verifier_user (id)
    ON DELETE RESTRICT;

-- Altera FK de batch.user_id para ON DELETE RESTRICT
ALTER TABLE batch
  DROP CONSTRAINT IF EXISTS batch_user_id_fkey;

ALTER TABLE batch
  ADD CONSTRAINT batch_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES verifier_user (id)
    ON DELETE RESTRICT;

-- Altera FK de validation.user_id para ON DELETE RESTRICT
ALTER TABLE validation
  DROP CONSTRAINT IF EXISTS validation_user_id_fkey;

ALTER TABLE validation
  ADD CONSTRAINT validation_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES verifier_user (id)
    ON DELETE RESTRICT;
