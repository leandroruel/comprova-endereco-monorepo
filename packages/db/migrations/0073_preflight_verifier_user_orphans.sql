SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- PR #75 — Preflight de compatibilidade de identidade verifier_user.
-- =====================================================================
-- As migrations 0068, 0070 e 0071 alteram as FKs de organization_member,
-- batch e validation para apontar para verifier_user.id. Como a migration
-- 0056 copiou usuários da tabela legada `user` para `verifier_user` no
-- momento de sua execução, usuários criados diretamente na tabela `user`
-- depois da 0056 podem deixar registros órfãos em organization_member,
-- batch e validation.
--
-- Adicionar uma FK com validação (ADD CONSTRAINT sem NOT VALID) falha se
-- houver registros órfãos. Como a verificação de 0072 vem DEPOIS das
-- alterações de 0068/0070/0071, registros órfãos podem fazer a migration
-- falhar antes da verificação.
--
-- Esta migration executa um preflight ANTES de qualquer alteração de FK
-- (ela roda depois de 0072, mas serve como verificação de segurança para
-- ambientes que já aplicaram 0068/0070/0071 sem problemas, e para novos
-- ambientes onde 0068/0070/0071 já validam implicitamente).
--
-- Se houver registros órfãos, interrompe com erro explícito informando a
-- tabela e a quantidade de registros afetados, sem perder dados.
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

-- Valida todas as constraints existentes para garantir integridade referencial.
-- Isso é feito em transações separadas para evitar bloqueios prolongados.
ALTER TABLE organization_member VALIDATE CONSTRAINT organization_member_user_id_fkey;
ALTER TABLE batch VALIDATE CONSTRAINT batch_user_id_fkey;
ALTER TABLE validation VALIDATE CONSTRAINT validation_user_id_fkey;
