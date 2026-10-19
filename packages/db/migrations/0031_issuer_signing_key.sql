SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- FASE 14: identidade criptográfica por tenant (issuer signing key)
-- =====================================================================
-- Antes desta migration, TODOS os issuers assinavam com UMA única chave global
-- (`CREDENTIAL_SIGNING_PRIVATE_KEY`): o comprometimento dela atingia todos os
-- tenants. Aqui se cria o registro mínimo que escopa a chave por tenant.
--
-- A tabela guarda SOMENTE material público — a chave pública Ed25519 crua (32
-- bytes) e os metadados do método. A chave privada NUNCA é persistida: ela vive
-- em configuração/segredo externo e é associada por (`tenant_id`, `key_id`)
-- (ADR-0026). Isto é uma limitação operacional DELIBERADA deste passo: não há
-- KMS/HSM nem criptografia caseira.
--
-- `issuer_scope` é o digest opaco do tenant que aparece em `issuer.id`
-- (`<origin>/issuers/<scope>`); é o que permite ao endpoint público resolver a
-- chave pelo `issuer.id` sem reverter o digest (que é one-way).
--
-- Não se alteram validation/claim/claim_evidence/signal/evidence, scoring,
-- checkers, policy, retenção nem o formato da VC.

CREATE TABLE issuer_signing_key (
  issuer_signing_key_id uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES tenant (tenant_id),
  issuer_scope          text NOT NULL,
  key_id                text NOT NULL,
  algorithm             text NOT NULL,
  public_key            bytea NOT NULL,
  -- `false` = chave superada (rotação futura): deixa de assinar credenciais
  -- novas, mas continua publicada para verificar as antigas.
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- `key_id` é único DENTRO do issuer (tenant): o namespace do verificationMethod
-- é o issuer, então `key-1` pode repetir entre tenants.
CREATE UNIQUE INDEX issuer_signing_key_tenant_key_uq
  ON issuer_signing_key (tenant_id, key_id);

-- No máximo UMA chave ativa por tenant: a seleção da chave de emissão é
-- determinística, sem "qual das ativas?".
CREATE UNIQUE INDEX issuer_signing_key_active_uq
  ON issuer_signing_key (tenant_id)
  WHERE active;

-- O endpoint público resolve o documento por `issuer_scope`.
CREATE INDEX issuer_signing_key_scope_idx ON issuer_signing_key (issuer_scope);

ALTER TABLE issuer_signing_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE issuer_signing_key FORCE ROW LEVEL SECURITY;

-- Leitura/escrita escopada pelo tenant dono: A não lê nem altera a chave de B.
CREATE POLICY tenant_isolation ON issuer_signing_key
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- A tabela carrega apenas material PÚBLICO (chave pública e metadados do
-- método) — nunca a privada. O endpoint público de resolução
-- (`GET /issuers/:scope`) precisa lê-la SEM contexto de tenant, então o SELECT
-- é público por construção; nada confidencial é exposto.
CREATE POLICY public_key_read ON issuer_signing_key FOR SELECT USING (true);

-- O aplicativo só LÊ a chave. A provisão é operação de admin/seed (como a
-- criação de `api_key`), que roda com o papel owner; o app não escreve aqui.
GRANT SELECT ON issuer_signing_key TO app_user;
