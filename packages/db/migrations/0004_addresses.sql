SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

CREATE TABLE canonical_address (
  address_id        uuid PRIMARY KEY,
  building_key      bytea NOT NULL UNIQUE,
  country_code      char(2) NOT NULL DEFAULT 'BR',
  uf                char(2),
  municipio_ibge    int,
  cep               char(8),
  logradouro_norm   text,
  numero            text,
  bairro_norm       text,
  geom              geography(Point,4326),
  geo_precision     geo_precision NOT NULL DEFAULT 'NONE',
  geo_consensus_m   real,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_verified_at   timestamptz
);
CREATE INDEX idx_addr_geom ON canonical_address USING gist (geom);
CREATE INDEX idx_addr_cep  ON canonical_address (cep);

CREATE TABLE address_profile (
  address_id             uuid PRIMARY KEY REFERENCES canonical_address,
  active_cnpj_count      int NOT NULL,
  active_matriz_count    int NOT NULL,
  distinct_cnae_div      int NOT NULL,
  distinct_partner_count int NOT NULL,
  top_partner_share      real,
  is_known_shared        boolean NOT NULL DEFAULT false,
  shared_kind            text,
  opened_last_12m        int NOT NULL DEFAULT 0,
  computed_from_snapshot date NOT NULL,
  computed_at            timestamptz NOT NULL DEFAULT now()
);
