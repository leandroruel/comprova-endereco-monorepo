SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- FASE 24/A3-C1: separa o binding IMUTÁVEL da assertion (policy_hash/
-- scorer_version, gravados na criação e protegidos pelo trigger de 0028/0030)
-- da ÚLTIMA avaliação feita pelo deep path.
--
-- O worker carrega a policy do deploy atual. Sem esta coluna, comparar o replay
-- só com o binding imutável faz uma policy nova parecer "nova" em TODA
-- reexecução: o completed_at avança de novo e uma credencial emitida depois da
-- primeira reavaliação seria revogada como superada por um replay idêntico.
--
-- As colunas são mutáveis de propósito: registram qual policy/scorer produziu o
-- resultado mais recente. O binding de emissão continua em policy_hash/
-- scorer_version, que não são tocados.
ALTER TABLE validation ADD COLUMN last_evaluated_policy_hash text;
ALTER TABLE validation ADD COLUMN last_evaluated_scorer_version text;

-- Backfill: para linhas existentes, a última avaliação conhecida é o binding
-- gravado na criação. Linhas criadas depois começam NULL e são preenchidas pelo
-- primeiro deep path; nesse caso o código usa o binding como fallback.
UPDATE validation
SET last_evaluated_policy_hash = policy_hash,
    last_evaluated_scorer_version = scorer_version
WHERE policy_hash IS NOT NULL;

COMMENT ON COLUMN validation.last_evaluated_policy_hash IS
  'Digest da policy usada na última execução do deep path (mutável; distinto do binding imutável policy_hash)';
COMMENT ON COLUMN validation.last_evaluated_scorer_version IS
  'Versão do scorer usada na última execução do deep path (mutável; distinto do binding imutável scorer_version)';
