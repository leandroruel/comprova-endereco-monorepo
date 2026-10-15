SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

CREATE TABLE ref_estabelecimento_history (
  cnpj_basico        char(8)  NOT NULL,
  cnpj_ordem         char(4)  NOT NULL,
  cnpj_dv            char(2)  NOT NULL,
  matriz_filial      smallint NOT NULL,
  nome_fantasia      text,
  situacao_cadastral smallint NOT NULL,
  data_situacao      date,
  motivo_situacao    smallint,
  data_abertura      date,
  cnae_principal     char(7),
  cnaes_secundarios  char(7)[],
  tipo_logradouro    text,
  logradouro         text,
  numero             text,
  complemento        text,
  bairro             text,
  cep                char(8),
  uf                 char(2),
  municipio_receita  int,
  municipio_ibge     int,
  pais_codigo        int,
  cidade_exterior    text,
  telefone           text,
  email_domain       text,
  building_key       bytea,
  unit_key           bytea,
  snapshot_month     date NOT NULL,
  valid_from         date NOT NULL,
  valid_to           date NOT NULL,
  PRIMARY KEY (cnpj_basico, cnpj_ordem, cnpj_dv, valid_from)
) PARTITION BY HASH (cnpj_basico);

DO $$
BEGIN
  FOR i IN 0..31 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS ref_estabelecimento_history_p%s PARTITION OF ref_estabelecimento_history FOR VALUES WITH (MODULUS 32, REMAINDER %s)',
      i, i);
  END LOOP;
END $$;

CREATE INDEX idx_estab_history_cnpj ON ref_estabelecimento_history (cnpj_basico, valid_from DESC);
CREATE INDEX idx_estab_history_building ON ref_estabelecimento_history (building_key) WHERE situacao_cadastral = 2;
