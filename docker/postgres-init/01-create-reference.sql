-- Criação do database de referência (CNEFE/Receita Federal) na primeira
-- inicialização da instância (`/docker-entrypoint-initdb.d`). Mantém os dois
-- domínios na MESMA instância PostgreSQL, como exige a separação.
--
-- Obs.: este script roda só num cluster novo (docker-entrypoint padrão). Para
-- instâncias existentes, execute manualmente:
--   psql "$DATABASE_ADMIN_URL" -c 'CREATE DATABASE "comprova_reference";'
-- Credenciais dos papéis (`app_user`) são configuradas pelas migrations
-- operacionais e reutilizadas (papéis são cluster-level).
CREATE DATABASE "comprova_reference";
