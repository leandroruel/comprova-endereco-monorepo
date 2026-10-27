SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- F3: estado durável da reavaliação pós-consulta fiscal
-- =====================================================================
-- O tick fiscal materializa a evidência fiscal em `claim_evidence` e SÓ
-- DEPOIS reavalia o claim (`deepEnrich`), em transações distintas. Entre as
-- duas, o GET expõe `fiscal_verification` com o veredito/score da avaliação
-- ANTERIOR; e uma reavaliação que falha mantém a linha fiscal enquanto o
-- worker agenda retry (backoff). Sem um estado durável, o cliente não
-- distingue "consulta chegou, reavaliação em andamento" de "resultado final"
-- e pode encerrar o acompanhamento cedo demais, exibindo o veredito antigo.
--
--   NULL        → nenhuma reavaliação fiscal registrada
--   'pending'   → reavaliação em andamento ou retry agendado
--   'completed' → `deepEnrich` concluiu DEPOIS da materialização fiscal
--
-- A coluna vive na validation (o agregado do assessment) e é escrita apenas
-- pelo tick fiscal, sob RLS do tenant. Não é PII nem parte do binding
-- imutável (`policy_hash`/`scorer_version`/`evidence_set_hash`): é estado
-- operacional da avaliação, como `last_evaluated_*`.
--
-- Invariante da fatia: um intake por claim (ver `fiscal-verification.tick`),
-- então a coluna descreve a referência fiscal corrente da validation.
ALTER TABLE validation ADD COLUMN fiscal_reassessment text;

ALTER TABLE validation
  ADD CONSTRAINT validation_fiscal_reassessment_ck
  CHECK (fiscal_reassessment IS NULL OR fiscal_reassessment IN ('pending', 'completed'))
  NOT VALID;

-- `NOT VALID` evita o scan bloqueante sob `lock_timeout`. A validação fica na
-- migração seguinte (0046), em outra transação: o runner executa cada arquivo
-- em um único BEGIN, e validar aqui manteria o ACCESS EXCLUSIVE do
-- ADD CONSTRAINT ativo durante o scan, bloqueando leituras/escritas.
COMMENT ON COLUMN validation.fiscal_reassessment IS
  'Estado da reavaliação após a consulta fiscal: NULL | pending | completed.';
