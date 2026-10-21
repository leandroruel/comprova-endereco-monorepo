SET lock_timeout = '5s';
-- A validação varre a tabela inteira; sem statement_timeout para não abortar
-- em bases grandes. O lock é SHARE UPDATE EXCLUSIVE (não bloqueia leituras nem
-- escritas), diferente do ACCESS EXCLUSIVE mantido pelo ADD CONSTRAINT.
SET statement_timeout = '0';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- Valida a constraint criada como NOT VALID na 0035.
--
-- Arquivo separado de propósito: `packages/db/src/runner.ts` executa cada
-- migração dentro de uma única transação. Se o VALIDATE estivesse no mesmo
-- arquivo do ADD CONSTRAINT, o ACCESS EXCLUSIVE continuaria ativo durante o
-- scan. Aqui o runner confirma primeiro a transação da 0035 e só então valida.
ALTER TABLE credential_status VALIDATE CONSTRAINT credential_status_reason_ck;
