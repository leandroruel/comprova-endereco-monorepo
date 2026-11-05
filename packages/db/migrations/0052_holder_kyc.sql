SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- Tabela de titulares (Holders) para o módulo KYC.
-- Um titular pertence a uma organização Verifier (tenant) e não deve conter
-- dados pessoais em texto puro. Os identificadores pessoais (CPF/CNPJ) são
-- armazenados como hash para aplicar minimização de dados.
CREATE TABLE holder (
  holder_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  external_reference text NOT NULL,      -- referência externa do Verifier para o titular
  name text NOT NULL,                    -- nome do titular (não é identificador único)
  document_hash text NOT NULL,           -- HMAC-SHA-256 do CPF/CNPJ com segredo protegido (texto puro nunca é armazenado)
  document_type text NOT NULL DEFAULT 'CPF',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT holder_document_type_check CHECK (document_type IN ('CPF', 'CNPJ')),
  CONSTRAINT holder_tenant_external_reference_unique UNIQUE (tenant_id, external_reference),
  -- Chave única composta para integridade referencial com kyc_process.
  CONSTRAINT holder_id_tenant_unique UNIQUE (holder_id, tenant_id)
);
CREATE INDEX idx_holder_tenant ON holder (tenant_id);
-- Índice de document_hash isolado por tenant (privacidade e isolamento multi-tenant).
CREATE INDEX idx_holder_document_hash ON holder (tenant_id, document_hash);
GRANT SELECT, INSERT, UPDATE, DELETE ON holder TO app_user;

-- AVISO DE SEGURANÇA: document_hash armazena um HMAC-SHA-256 (não SHA-256
-- simples) do CPF/CNPJ com um segredo protegido derivado POR TENANT.
--
-- SHA-256 simples é insuficiente para documentos com espaço de valores
-- previsível (CPF/CNPJ), pois permite ataque por enumeração.
--
-- O segredo HMAC deve ser derivado por tenant:
--   tenantSpecificSecret = HMAC(globalSecret, tenantId)
-- onde globalSecret é provido via variável de ambiente do Verifier
-- (ex.: HOLDER_DOCUMENT_HMAC_SECRET).
--
-- O mesmo CPF/CNPJ em tenants diferentes produz identificadores diferentes,
-- impedindo correlação global de titulares entre organizações.
--
-- O segredo HMAC NUNCA é armazenado neste banco de dados. É provido pelo
-- Verifier via variável de ambiente e compartilhado com o serviço Comprova de
-- forma out-of-band. O cálculo do HMAC é responsabilidade da camada de
-- integração do Verifier; o Comprova apenas valida o formato (64 caracteres
-- hexadecimais) e armazena o valor recebido.
--
-- Rotação de segredos: ao rotacionar o segredo global, registros existentes
-- deixam de ser reconhecíveis. A migração requer re-calculo do HMAC pelo
-- Verifier com o novo segredo e atualização via PATCH /holders/:holderId.
-- Não há re-hash automático e não há perda silenciosa de capacidade de
-- localizar registros (os registros antigos permanecem armazenados, mas o
-- documentHash antigo não corresponde mais ao novo cálculo).

-- Processos de KYC associados a um titular.
-- O estado do KYC é independente das obrigações documentais.
CREATE TABLE kyc_process (
  kyc_process_id uuid PRIMARY KEY,
  holder_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'in_progress', 'approved', 'rejected', 'expired')),
  legal_basis text NOT NULL,            -- base legal do processamento (ex: 'CONSENT', 'CONTRACT_EXECUTION')
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,                -- expiração opcional do processo
  -- Integridade referencial composta: holder pertence ao mesmo tenant.
  CONSTRAINT kyc_process_holder_tenant_fk
    FOREIGN KEY (holder_id, tenant_id)
    REFERENCES holder (holder_id, tenant_id),
  -- Chave única composta para integridade referencial com kyc_event.
  CONSTRAINT kyc_process_id_tenant_unique UNIQUE (kyc_process_id, tenant_id)
);
CREATE INDEX idx_kyc_process_holder ON kyc_process (holder_id);
CREATE INDEX idx_kyc_process_tenant ON kyc_process (tenant_id);
CREATE INDEX idx_kyc_process_state ON kyc_process (state);
GRANT SELECT, INSERT, UPDATE, DELETE ON kyc_process TO app_user;

-- Eventos de auditoria para transições de estado e operações de KYC.
-- Cada transição de estado gera um evento imutável, permitindo rastrear quem
-- alterou o estado, quando e por quê.
-- Eventos são imutáveis: apenas SELECT e INSERT são permitidos (sem UPDATE/DELETE).
CREATE TABLE kyc_event (
  kyc_event_id uuid PRIMARY KEY,
  kyc_process_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  event_type text NOT NULL,             -- 'created', 'state_transitioned', 'document_added', etc.
  from_state text,                      -- estado anterior (nulo para 'created')
  to_state text NOT NULL,               -- novo estado
  actor text NOT NULL,                  -- quem executou (ex: 'api-key:<id>')
  details text NOT NULL DEFAULT '{}',   -- detalhes adicionais do evento (JSON)
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Integridade referencial composta: o evento pertence ao mesmo tenant do processo.
  CONSTRAINT kyc_event_process_tenant_fk
    FOREIGN KEY (kyc_process_id, tenant_id)
    REFERENCES kyc_process (kyc_process_id, tenant_id)
);
CREATE INDEX idx_kyc_event_process ON kyc_event (kyc_process_id);
CREATE INDEX idx_kyc_event_tenant ON kyc_event (tenant_id);
CREATE INDEX idx_kyc_event_created_at ON kyc_event (created_at);
GRANT SELECT, INSERT ON kyc_event TO app_user;
