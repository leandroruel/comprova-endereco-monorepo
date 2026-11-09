SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- Permissões do database de referência: leitura e escrita separadas.
--   app_user   → somente SELECT (API/worker à prova de escrita acidental;
--                INSERT/UPDATE/DELETE nas refs é exclusivo do ingestor).
--   ingestor   → superuser (bulk COPY/UPDATE de carga), fora dos grants.
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO app_user;

-- Sequências não existem nas tabelas de referência (chaves são IDs externos);
-- o GRANT abaixo é defensivo para o caso de uma sequência futura.
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user;
