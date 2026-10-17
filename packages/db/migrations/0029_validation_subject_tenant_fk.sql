SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- §14.8 / §19 (auditoria de verificabilidade): garantir no banco que
--   validation.tenant_id = subject.tenant_id.
--
-- A FK `validation.subject_id -> subject(subject_id)` (0005) valida apenas a
-- EXISTÊNCIA do subject (o check de FK roda como owner e ignora RLS), de modo
-- que um registro poderia apontar para um subject de OUTRO tenant. Mesmo padrão
-- já adotado para `claim -> subject` (0025): FK COMPOSTA apoiada na chave única
-- `subject_subject_id_tenant_id_key`.
--
-- OBS: o PostgreSQL NÃO suporta `NOT VALID` em FK de tabela particionada, então
-- a FK é criada já validada (verificado: 0 violações no estado atual).

ALTER TABLE validation
  ADD CONSTRAINT validation_subject_tenant_fk
  FOREIGN KEY (subject_id, tenant_id) REFERENCES subject (subject_id, tenant_id);
