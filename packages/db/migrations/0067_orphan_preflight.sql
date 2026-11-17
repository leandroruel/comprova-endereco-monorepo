SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- PR #75 — Preflight de compatibilidade de identidade verifier_user.
-- =====================================================================
-- Esta migration roda ANTES das migrations 0068, 0070 e 0071, que alteram
-- as FKs de organization_member, batch e validation para apontar para
-- verifier_user.id.
--
-- Como a migration 0056 copiou usuários da tabela legada `user` para
-- verifier_user no momento de sua execução, usuários criados diretamente
-- na tabela `user` depois da 0056 podem deixar registros órfãos em
-- organization_member, batch e validation.
--
-- Adicionar uma FK com validação (ADD CONSTRAINT sem NOT VALID) falha se
-- houver registros órfãos. Esta migration verifica a existência de
-- registros órfãos ANTES de qualquer alteração de FK, lançando erro
-- explícito com a tabela e a quantidade de registros afetados, sem
-- perder dados.
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
      'PR #75 preflight: registros órfãos encontrados — não é possível aplicar FK para verifier_user. '
      'organization_member: %s órfão(s), batch: %s órfão(s), validation: %s órfão(s). '
      'Reconcilie os registros antes de aplicar as migrations 0068/0070/0071.',
      org_member_orphans, batch_orphans, validation_orphans
    );
    RAISE EXCEPTION '%', msg;
  END IF;
END $$;
