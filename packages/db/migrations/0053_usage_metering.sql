SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- F3.3 — Medição de uso, idempotência, cotas e reconciliação
--
-- Evolui `usage_event` de forma aditiva (compatível com registros históricos)
-- e cria tabelas de suporte para idempotência e auditoria de cotas.
-- ============================================================================

-- ============================================================================
-- 1. ALTER TABLE: adiciona colunas canônicas de uso em `usage_event` (aditivo,
--    compatível com registros históricos). Executado separadamente dos índices.
-- ============================================================================

-- Identificador de evento para referência estável (coluna sem PK, pois
-- `usage_event` é particionada e não aceita PK global sem a chave de partição).
ALTER TABLE usage_event
  ADD COLUMN IF NOT EXISTS event_id uuid;

ALTER TABLE usage_event
  ADD COLUMN IF NOT EXISTS event_type text NOT NULL DEFAULT 'technical_execution';

ALTER TABLE usage_event
  ADD COLUMN IF NOT EXISTS idempotency_key text;

ALTER TABLE usage_event
  ADD COLUMN IF NOT EXISTS billable boolean NOT NULL DEFAULT false;

ALTER TABLE usage_event
  ADD COLUMN IF NOT EXISTS source text;

-- ============================================================================
-- 2. Índices de suporte (não únicos: a unicidade global da chave de
--    idempotência é garantida pela tabela dedicada `usage_event_idempotency`,
--    não particionada — veja ADR-0044 item 2 e CodeRabbit o). Em tabela
--    particionada por `occurred_at`, um índice único não pode abranger colunas
--    fora da chave de partição, portanto não há `UNIQUE` aqui.
--
--    Estratégia operacional (finding 6 da revisão): os índices são criados com
--    `CREATE INDEX` convencional DENTRO da transação da migration. Não usamos
--    `CREATE INDEX CONCURRENTLY` porque (a) o runner (`packages/db/src/runner.ts`)
--    executa cada migration dentro de uma transação e o PostgreSQL não aceita
--    `CONCURRENTLY` em transação; (b) `CREATE INDEX CONCURRENTLY` não é suportado
--    sobre a tabela particionada pai; e (c) `usage_event` é particionada
--    mensalmente com volume por partição pequeno no lançamento da F3.3 — a
--    construção é rápida, o `lock_timeout`/`statement_timeout` acima limitam o
--    bloqueio e uma falha é retrátil (a migration é all-or-nothing). Se o
--    volume crescer a ponto de isso doer, o caminho é criar o índice
--    concorrentemente em cada partição e anexá-lo (`ATTACH PARTITION INDEX`)
--    numa migration não transacional — decisão deliberadamente NÃO tomada aqui
--    para não alterar o comportamento global do runner.
-- ============================================================================

-- Índice para consulta de consumo por tenant + período.
CREATE INDEX IF NOT EXISTS idx_usage_event_tenant_period
  ON usage_event (tenant_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_usage_event_billable
  ON usage_event (tenant_id, billable, occurred_at)
  WHERE billable = true;

-- Índice para lookup por validation_id.
CREATE INDEX IF NOT EXISTS idx_usage_event_validation
  ON usage_event (validation_id)
  WHERE validation_id IS NOT NULL;

-- Índice para lookup de idempotência.
CREATE INDEX IF NOT EXISTS idx_usage_event_idempotency
  ON usage_event (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ============================================================================
-- 3. Tabelas dedicadas (não particionadas).
-- ============================================================================

-- Tabela dedicada para idempotência global de eventos de uso, seguindo o
-- padrão de `validation_idempotency` (ADR-0004).
CREATE TABLE IF NOT EXISTS usage_event_idempotency (
  tenant_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key)
);

-- ============================================================================
-- 3a. Identidade comercial da unidade faturável (ADR-0044 §3).
--
--     A unidade faturável é única por (tenant_id, validation_id),
--     INDEPENDENTE do caminho técnico (fast ou deep) que a registrou. Chaves
--     de idempotência são disciplina de aplicação; esta tabela é a garantia do
--     BANCO: `ON CONFLICT DO NOTHING` em (tenant_id, validation_id) faz com
--     que apenas a primeira execução a faturar uma validação vença, mesmo sob
--     concorrência entre fast e deep com chaves diferentes. Tabela NÃO
--     particionada, pois `usage_event` (particionada por `occurred_at`) não
--     aceita constraint única global fora da chave de particionamento.
-- ============================================================================
CREATE TABLE IF NOT EXISTS usage_billing_unit (
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  validation_id uuid NOT NULL,
  event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, validation_id)
);
CREATE INDEX IF NOT EXISTS idx_usage_billing_unit_event ON usage_billing_unit (event_id);

-- Auditoria de alterações de cota por tenant.
CREATE TABLE IF NOT EXISTS tenant_quota_audit (
  audit_id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  previous_quota bigint,
  new_quota bigint,
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text
);
CREATE INDEX IF NOT EXISTS idx_tenant_quota_audit_tenant ON tenant_quota_audit (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_quota_audit_changed_at ON tenant_quota_audit (changed_at);

-- ============================================================================
-- 4. RLS nas novas tabelas (padrão existente: FORCE + app_tenant_id()).
--    Aplicado IMEDIATAMENTE após cada CREATE TABLE e ANTES de qualquer DML
--    (backfill): as tabelas nascem vazias e já protegidas.
-- ============================================================================

ALTER TABLE usage_event_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_event_idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_event_idempotency
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE tenant_quota_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_quota_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_quota_audit
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE usage_billing_unit ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_billing_unit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_billing_unit
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- ============================================================================
-- 5. Grants
-- ============================================================================

GRANT SELECT, INSERT, UPDATE ON usage_event_idempotency TO app_user;
GRANT SELECT, INSERT ON tenant_quota_audit TO app_user;
GRANT SELECT, INSERT, UPDATE ON usage_billing_unit TO app_user;

-- usage_event já tem grants (0008_grants.sql). Reafirmar para as novas colunas.
GRANT SELECT, INSERT, UPDATE ON usage_event TO app_user;

-- ============================================================================
-- 6. Backfill histórico (finding 3 da revisão).
--
--    Política de migração dos eventos históricos (decidida, não implícita):
--
--    a. Registros históricos NÃO são presumidos livres de duplicidade: para
--       cada (tenant_id, validation_id) de validação CONCLUÍDA, exatamente UM
--       evento é promovido a unidade faturável canônica; os demais permanecem
--       como eventos técnicos (histórico preservado, não apagado).
--    b. O evento canônico recebe `event_type = 'usage_event'`,
--       `billable = true` e a chave comercial canônica
--       `validation:<validation_id>` (a mesma usada pelos caminhos fast/deep),
--       além de linha em `usage_event_idempotency` e em `usage_billing_unit`.
--    c. Eventos de validação NÃO concluída (partial/queued/failed) e eventos
--       sem `validation_id` permanecem `technical_execution` / `billable =
--       false` — indisponibilidade, tentativa e replay não geram consumo
--       comercial.
--    d. A promoção é determinística: preferência por evento já faturável,
--       depois o mais recente (`occurred_at DESC`, `event_id` como desempate).
--    e. Isolamento por tenant é respeitado: o join casa `tenant_id` E
--       `validation_id`; eventos de outro tenant não promovem unidades.
--    f. Consumo comercial (`getConsumption`/`getQuota`) soma apenas
--       `billable = true`, então o backfill não pode inflar cotas.
-- ============================================================================

-- 4.0. Registros históricos não têm `event_id` (coluna nova). Atribuir um
--      identificador estável para permitir deduplicação e referência nas
--      tabelas de idempotência/identidade comercial.
UPDATE usage_event
SET event_id = gen_random_uuid()
WHERE event_id IS NULL;

-- 4.1. Redes segurança: nada pré-existente pode estar faturável fora da regra
--      canônica (ex.: execuções antigas do backfill ou dados manuais).
UPDATE usage_event u
SET event_type = 'technical_execution',
    billable = false
WHERE u.billable = true
  AND (
    u.validation_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM validation v
      WHERE v.validation_id = u.validation_id
        AND v.tenant_id = u.tenant_id
        AND v.status = 'completed'
    )
  );

-- 4.2. Promover EXATAMENTE UM evento canônico por validação concluída.
WITH completed AS (
  SELECT v.tenant_id, v.validation_id
  FROM validation v
  WHERE v.status = 'completed'
),
ranked AS (
  SELECT u.event_id,
         ROW_NUMBER() OVER (
           PARTITION BY u.tenant_id, u.validation_id
           ORDER BY u.billable DESC, u.occurred_at DESC, u.event_id
         ) AS rn
  FROM usage_event u
  JOIN completed c
    ON c.tenant_id = u.tenant_id
   AND c.validation_id = u.validation_id
)
UPDATE usage_event u
SET event_type = 'usage_event',
    billable = true,
    idempotency_key = 'validation:' || u.validation_id::text
FROM ranked r
WHERE u.event_id = r.event_id
  AND r.rn = 1;

-- 4.3. Registrar a identidade comercial no banco (garantia estrutural) e a
--      chave canônica na idempotência, para que retries/replays dos caminhos
--      fast/deep sobre validações históricas sejam reconhecidos como replay.
INSERT INTO usage_event_idempotency (tenant_id, idempotency_key, event_id)
SELECT u.tenant_id, u.idempotency_key, u.event_id
FROM usage_event u
WHERE u.billable = true
  AND u.validation_id IS NOT NULL
  AND u.idempotency_key IS NOT NULL
ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;

INSERT INTO usage_billing_unit (tenant_id, validation_id, event_id)
SELECT u.tenant_id, u.validation_id, u.event_id
FROM usage_event u
WHERE u.billable = true
  AND u.validation_id IS NOT NULL
ON CONFLICT (tenant_id, validation_id) DO NOTHING;

