SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- 0083 — Políticas de escrita para tabelas gravadas pela aplicação
-- ============================================================================
-- A migration 0074 habilitou FORCE ROW LEVEL SECURITY em tabelas de referência
-- e de domínio, mas criou apenas políticas de SELECT. Como o role `app_user`
-- grava em algumas dessas tabelas (fast path e worker), os INSERTs passaram a
-- falhar com "new row violates row-level security policy".
--
-- Esta migration adiciona as políticas de escrita que faltavam, mantendo:
--   * tabelas globais (sem tenant): escrita permitida ao `app_user`;
--   * `signal` (sem tenant_id): escrita derivada do tenant da `validation`.
--
-- Também remove artefatos de depuração de tentativas anteriores, caso tenham
-- sido aplicados em algum ambiente local.

-- ---------------------------------------------------------------------------
-- Limpeza idempotente de políticas/funções de depuração
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS signal_app_user_all ON signal;
DROP POLICY IF EXISTS signal_app_user_insert ON signal;
DROP POLICY IF EXISTS signal_app_user_update ON signal;
DROP POLICY IF EXISTS signal_app_user_delete ON signal;
DROP POLICY IF EXISTS canonical_address_app_user_insert ON canonical_address;
DROP POLICY IF EXISTS canonical_address_app_user_update ON canonical_address;
DROP FUNCTION IF EXISTS signal_belongs_to_current_tenant(uuid);

-- ---------------------------------------------------------------------------
-- signal — escrita escopada ao tenant dono da validation
-- ---------------------------------------------------------------------------
-- O fast path insere os sinais ANTES da linha de `validation` (a validation só
-- é gravada no fim da transação). Por isso a checagem usa `claim`, que é criado
-- antes dos sinais e já carrega `tenant_id`. No worker o claim também já existe.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'signal') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'signal' AND policyname = 'signal_app_user_insert') THEN
      CREATE POLICY signal_app_user_insert ON signal FOR INSERT TO app_user
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM claim c
            WHERE c.validation_id = signal.validation_id
              AND c.tenant_id = app_tenant_id()
          )
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'signal' AND policyname = 'signal_app_user_update') THEN
      CREATE POLICY signal_app_user_update ON signal FOR UPDATE TO app_user
        USING (
          EXISTS (
            SELECT 1 FROM claim c
            WHERE c.validation_id = signal.validation_id
              AND c.tenant_id = app_tenant_id()
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM claim c
            WHERE c.validation_id = signal.validation_id
              AND c.tenant_id = app_tenant_id()
          )
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'signal' AND policyname = 'signal_app_user_delete') THEN
      CREATE POLICY signal_app_user_delete ON signal FOR DELETE TO app_user
        USING (
          EXISTS (
            SELECT 1 FROM claim c
            WHERE c.validation_id = signal.validation_id
              AND c.tenant_id = app_tenant_id()
          )
        );
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- outbox — barramento de eventos interno (escrita e publicação pela aplicação)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'outbox') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'outbox' AND policyname = 'outbox_app_user_insert') THEN
      CREATE POLICY outbox_app_user_insert ON outbox FOR INSERT TO app_user WITH CHECK (true);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'outbox' AND policyname = 'outbox_app_user_update') THEN
      CREATE POLICY outbox_app_user_update ON outbox FOR UPDATE TO app_user USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- evidence — metadados de evidência (gravados pelo worker)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'evidence') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'evidence' AND policyname = 'evidence_app_user_insert') THEN
      CREATE POLICY evidence_app_user_insert ON evidence FOR INSERT TO app_user WITH CHECK (true);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'evidence' AND policyname = 'evidence_app_user_update') THEN
      CREATE POLICY evidence_app_user_update ON evidence FOR UPDATE TO app_user USING (true) WITH CHECK (true);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'evidence' AND policyname = 'evidence_app_user_delete') THEN
      CREATE POLICY evidence_app_user_delete ON evidence FOR DELETE TO app_user USING (true);
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- canonical_address — endereço canônico global (fast path)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'canonical_address') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'canonical_address' AND policyname = 'canonical_address_app_user_insert') THEN
      CREATE POLICY canonical_address_app_user_insert ON canonical_address FOR INSERT TO app_user WITH CHECK (true);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'canonical_address' AND policyname = 'canonical_address_app_user_update') THEN
      CREATE POLICY canonical_address_app_user_update ON canonical_address FOR UPDATE TO app_user USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- address_profile — perfil agregado global (worker)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'address_profile') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'address_profile' AND policyname = 'address_profile_app_user_insert') THEN
      CREATE POLICY address_profile_app_user_insert ON address_profile FOR INSERT TO app_user WITH CHECK (true);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'address_profile' AND policyname = 'address_profile_app_user_update') THEN
      CREATE POLICY address_profile_app_user_update ON address_profile FOR UPDATE TO app_user USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- address_signal_cache — cache de sinais por endereço global (worker)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'address_signal_cache') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'address_signal_cache' AND policyname = 'address_signal_cache_app_user_insert') THEN
      CREATE POLICY address_signal_cache_app_user_insert ON address_signal_cache FOR INSERT TO app_user WITH CHECK (true);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'address_signal_cache' AND policyname = 'address_signal_cache_app_user_update') THEN
      CREATE POLICY address_signal_cache_app_user_update ON address_signal_cache FOR UPDATE TO app_user USING (true) WITH CHECK (true);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'address_signal_cache' AND policyname = 'address_signal_cache_app_user_delete') THEN
      CREATE POLICY address_signal_cache_app_user_delete ON address_signal_cache FOR DELETE TO app_user USING (true);
    END IF;
  END IF;
END $$;
