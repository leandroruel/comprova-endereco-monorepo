SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

GRANT SELECT, INSERT, UPDATE ON canonical_address TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON address_signal_cache TO app_user;
GRANT SELECT ON ref_receita_municipio TO app_user;
GRANT SELECT ON ref_cnae_divisao_categoria TO app_user;
