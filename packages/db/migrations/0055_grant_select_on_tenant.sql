SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- Concede SELECT na tabela tenant ao app_user.
-- A migration 0049 concedia apenas INSERT, UPDATE, o que impedia consultas
-- que fazem JOIN com tenant (ex.: listOrganizationsByUser em
-- apps/api/src/modules/organizations/organizations.service.ts) de funcionar
-- com a role app_user. Sem este grant, GET /v1/organizations retorna 500.
GRANT SELECT ON tenant TO app_user;
