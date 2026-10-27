SET lock_timeout = '5s';
-- A validação varre a tabela (e as partições); sem statement_timeout para não
-- abortar em bases grandes. O lock é SHARE UPDATE EXCLUSIVE (não bloqueia
-- leituras nem escritas), diferente do ACCESS EXCLUSIVE mantido pelo
-- ADD CONSTRAINT.
SET statement_timeout = '0';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- Valida a constraint criada como NOT VALID na 0045.
ALTER TABLE validation VALIDATE CONSTRAINT validation_fiscal_reassessment_ck;
