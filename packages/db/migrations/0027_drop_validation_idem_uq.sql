SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- BAIXO-6 (auditoria de integridade): remover índice de idempotência enganoso.
--
-- `validation_idem_uq (tenant_id, idempotency_key, created_at)` inclui a coluna
-- de particionamento (`created_at`), que muda a cada escrita. Ele, portanto,
-- NUNCA deduplica: dois pedidos com a mesma Idempotency-Key produzem
-- `created_at` diferentes e ambos passam.
--
-- A deduplicação real é feita por `validation_idempotency (tenant_id, idempotency_key)`,
-- cuja PK é a barreira transacional correta (insert-first + on conflict).
--
-- Não substituir por UNIQUE(tenant_id, idempotency_key) em `validation`: a tabela
-- é particionada por created_at e o PostgreSQL não permite índice único sem a
-- coluna de particionamento.

DROP INDEX IF EXISTS validation_idem_uq;
