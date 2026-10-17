SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- MÉDIO-5 (auditoria de integridade): garantir no banco que
--   claim.tenant_id = subject.tenant_id.
--
-- Antes desta migration, a FK `claim.subject_id -> subject(subject_id)` validava
-- apenas a EXISTÊNCIA do subject (o check de FK roda como owner e ignora RLS),
-- de modo que um claim do tenant A podia apontar para um subject do tenant B.
--
-- Solução: FK COMPOSTA (subject_id, tenant_id) -> subject(subject_id, tenant_id).
-- Requer uma constraint UNIQUE sobre as colunas referenciadas; como subject_id
-- já é PK, (subject_id, tenant_id) é trivialmente única.

-- 1) Chave única de apoio (subject_id já é único; o índice é exigido pelo PG
--    para a FK composta).
CREATE UNIQUE INDEX subject_subject_id_tenant_id_key ON subject (subject_id, tenant_id);
ALTER TABLE subject
  ADD CONSTRAINT subject_subject_id_tenant_id_key UNIQUE USING INDEX subject_subject_id_tenant_id_key;

-- 2) Substitui a FK simples por uma FK composta que também valida o tenant.
--    Mantém ON DELETE CASCADE (mesma semântica anterior).
ALTER TABLE claim DROP CONSTRAINT claim_subject_id_fkey;
ALTER TABLE claim
  ADD CONSTRAINT claim_subject_tenant_fk
  FOREIGN KEY (subject_id, tenant_id) REFERENCES subject (subject_id, tenant_id)
  ON DELETE CASCADE NOT VALID;

-- 3) Valida os dados existentes sem bloquear escrita (scan + lock leve).
ALTER TABLE claim VALIDATE CONSTRAINT claim_subject_tenant_fk;
