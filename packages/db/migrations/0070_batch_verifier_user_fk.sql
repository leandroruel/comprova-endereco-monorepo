SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- PR #74 — Identidade canônica do Verifier para batch.user_id.
-- =====================================================================
-- A coluna `batch.user_id` referenciava a tabela legada `user`. Altera para
-- apontar para `verifier_user.id`, consistente com a identidade do Verifier.
-- =====================================================================

ALTER TABLE batch
  DROP CONSTRAINT IF EXISTS batch_user_id_fkey;

ALTER TABLE batch
  ADD CONSTRAINT batch_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES verifier_user (id)
    ON DELETE CASCADE;

DROP INDEX IF EXISTS idx_batch_user;
CREATE INDEX idx_batch_user ON batch (user_id, created_at DESC) WHERE user_id IS NOT NULL;
