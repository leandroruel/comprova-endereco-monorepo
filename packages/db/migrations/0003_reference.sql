SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

CREATE TABLE ref_receita_estabelecimento (
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
  PRIMARY KEY (cnpj_basico, cnpj_ordem, cnpj_dv)
) PARTITION BY HASH (cnpj_basico);

DO $$
BEGIN
  FOR i IN 0..31 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS ref_receita_estabelecimento_p%s PARTITION OF ref_receita_estabelecimento FOR VALUES WITH (MODULUS 32, REMAINDER %s)',
      i, i);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_estab_building_p%s ON ref_receita_estabelecimento_p%s (building_key) WHERE situacao_cadastral = 2',
      i, i);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_estab_cep_p%s ON ref_receita_estabelecimento_p%s (cep)',
      i, i);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_estab_cnae_p%s ON ref_receita_estabelecimento_p%s (cnae_principal)',
      i, i);
  END LOOP;
END $$;

CREATE TABLE ref_receita_empresa (
  cnpj_basico        char(8) PRIMARY KEY,
  razao_social       text NOT NULL,
  natureza_juridica  int,
  capital_social     numeric(18,2),
  porte              smallint,
  snapshot_month     date NOT NULL
);

CREATE TABLE ref_receita_socio (
  cnpj_basico        char(8) NOT NULL,
  tipo_socio         smallint NOT NULL,
  nome_socio         text,
  doc_mascarado      text,
  qualificacao       smallint,
  data_entrada       date,
  partner_key        bytea NOT NULL,
  snapshot_month     date NOT NULL
);
CREATE INDEX idx_socio_cnpj    ON ref_receita_socio (cnpj_basico);
CREATE INDEX idx_socio_partner ON ref_receita_socio (partner_key);

CREATE TABLE ref_receita_simples (
  cnpj_basico  char(8) PRIMARY KEY,
  opcao_simples boolean, data_opcao_simples date, data_exclusao_simples date,
  opcao_mei boolean,     data_opcao_mei date,     data_exclusao_mei date
);

CREATE TABLE ref_cnefe_address (
  cnefe_id        bigint PRIMARY KEY,
  uf              char(2) NOT NULL,
  municipio_ibge  int NOT NULL,
  cep             char(8),
  logradouro_norm text NOT NULL,
  numero          text,
  complemento_norm text,
  especie         smallint,
  geom            geography(Point,4326) NOT NULL,
  census_year     smallint NOT NULL
);
CREATE INDEX idx_cnefe_geom   ON ref_cnefe_address USING gist (geom);
CREATE INDEX idx_cnefe_lookup ON ref_cnefe_address (municipio_ibge, logradouro_norm, numero);
CREATE INDEX idx_cnefe_trgm  ON ref_cnefe_address USING gin (logradouro_norm gin_trgm_ops);

CREATE TABLE ref_cep (
  cep             char(8) PRIMARY KEY,
  uf              char(2) NOT NULL,
  municipio_ibge  int,
  localidade      text,
  bairro          text,
  logradouro_norm text,
  geom            geography(Point,4326),
  source          text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ref_known_shared_address (
  building_key bytea PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('accounting_office','coworking','mailbox','registered_agent')),
  source       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
