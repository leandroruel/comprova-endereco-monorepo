SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

CREATE TABLE ref_receita_municipio (
  codigo_receita int PRIMARY KEY,
  codigo_ibge    int NOT NULL,
  nome_norm      text NOT NULL,
  uf             char(2) NOT NULL,
  UNIQUE (nome_norm, uf)
);

CREATE TABLE ref_cnae_divisao_categoria (
  divisao   char(2) PRIMARY KEY,
  categoria text NOT NULL CHECK (categoria IN ('RESIDENTIAL_COMPATIBLE','COMMERCIAL','INDUSTRIAL','AGRICULTURAL','PUBLIC_SERVICES','MIXED'))
);
