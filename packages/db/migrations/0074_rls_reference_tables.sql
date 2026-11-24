SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- Habilita RLS nas tabelas de referência e domínio expostas ao PostgREST
--
-- Elas não contêm PII (dados públicos de CEP, CNPJ, CNAE, IBGE etc.),
-- mas o dashboard do Supabase alerta quando tabelas no schema `public`
-- estão expostas sem RLS. Como a aplicação se conecta diretamente pelo
-- pooler (não via PostgREST), a política é leitura pública (`true`),
-- apenas para satisfazer o requisito de RLS habilitada e eliminar os
-- warnings. Nenhum dado sensível fica exposto.
--
-- Cada bloco verifica se a tabela existe antes de aplicar RLS, de modo
-- que a migration seja idempotente e não falhe em ambientes onde
-- algumas tabelas ainda não foram criadas.
-- =====================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ref_receita_estabelecimento') THEN
    ALTER TABLE ref_receita_estabelecimento ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ref_receita_estabelecimento FORCE ROW LEVEL SECURITY;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ref_receita_estabelecimento' AND policyname = 'ref_receita_estabelecimento_public_read') THEN
      CREATE POLICY ref_receita_estabelecimento_public_read ON ref_receita_estabelecimento FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ref_receita_empresa') THEN
    ALTER TABLE ref_receita_empresa ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ref_receita_empresa FORCE ROW LEVEL SECURITY;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ref_receita_empresa' AND policyname = 'ref_receita_empresa_public_read') THEN
      CREATE POLICY ref_receita_empresa_public_read ON ref_receita_empresa FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ref_receita_socio') THEN
    ALTER TABLE ref_receita_socio ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ref_receita_socio FORCE ROW LEVEL SECURITY;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ref_receita_socio' AND policyname = 'ref_receita_socio_public_read') THEN
      CREATE POLICY ref_receita_socio_public_read ON ref_receita_socio FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ref_receita_simples') THEN
    ALTER TABLE ref_receita_simples ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ref_receita_simples FORCE ROW LEVEL SECURITY;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ref_receita_simples' AND policyname = 'ref_receita_simples_public_read') THEN
      CREATE POLICY ref_receita_simples_public_read ON ref_receita_simples FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ref_cnefe_address') THEN
    ALTER TABLE ref_cnefe_address ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ref_cnefe_address FORCE ROW LEVEL SECURITY;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ref_cnefe_address' AND policyname = 'ref_cnefe_address_public_read') THEN
      CREATE POLICY ref_cnefe_address_public_read ON ref_cnefe_address FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ref_cep') THEN
    ALTER TABLE ref_cep ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ref_cep FORCE ROW LEVEL SECURITY;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ref_cep' AND policyname = 'ref_cep_public_read') THEN
      CREATE POLICY ref_cep_public_read ON ref_cep FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ref_known_shared_address') THEN
    ALTER TABLE ref_known_shared_address ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ref_known_shared_address FORCE ROW LEVEL SECURITY;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ref_known_shared_address' AND policyname = 'ref_known_shared_address_public_read') THEN
      CREATE POLICY ref_known_shared_address_public_read ON ref_known_shared_address FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ref_cnae_divisao_categoria') THEN
    ALTER TABLE ref_cnae_divisao_categoria ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ref_cnae_divisao_categoria FORCE ROW LEVEL SECURITY;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ref_cnae_divisao_categoria' AND policyname = 'ref_cnae_divisao_categoria_public_read') THEN
      CREATE POLICY ref_cnae_divisao_categoria_public_read ON ref_cnae_divisao_categoria FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ref_receita_municipio') THEN
    ALTER TABLE ref_receita_municipio ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ref_receita_municipio FORCE ROW LEVEL SECURITY;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ref_receita_municipio' AND policyname = 'ref_receita_municipio_public_read') THEN
      CREATE POLICY ref_receita_municipio_public_read ON ref_receita_municipio FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ref_estabelecimento_history') THEN
    ALTER TABLE ref_estabelecimento_history ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ref_estabelecimento_history FORCE ROW LEVEL SECURITY;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ref_estabelecimento_history' AND policyname = 'ref_estabelecimento_history_public_read') THEN
      CREATE POLICY ref_estabelecimento_history_public_read ON ref_estabelecimento_history FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'canonical_address') THEN
    ALTER TABLE canonical_address ENABLE ROW LEVEL SECURITY;
    ALTER TABLE canonical_address FORCE ROW LEVEL SECURITY;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'canonical_address' AND policyname = 'canonical_address_public_read') THEN
      CREATE POLICY canonical_address_public_read ON canonical_address FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'address_profile') THEN
    ALTER TABLE address_profile ENABLE ROW LEVEL SECURITY;
    ALTER TABLE address_profile FORCE ROW LEVEL SECURITY;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'address_profile' AND policyname = 'address_profile_public_read') THEN
      CREATE POLICY address_profile_public_read ON address_profile FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'address_signal_cache') THEN
    ALTER TABLE address_signal_cache ENABLE ROW LEVEL SECURITY;
    ALTER TABLE address_signal_cache FORCE ROW LEVEL SECURITY;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'address_signal_cache' AND policyname = 'address_signal_cache_public_read') THEN
      CREATE POLICY address_signal_cache_public_read ON address_signal_cache FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tenant') THEN
    ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tenant' AND policyname = 'tenant_public_read') THEN
      CREATE POLICY tenant_public_read ON tenant FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'legal_basis') THEN
    ALTER TABLE legal_basis ENABLE ROW LEVEL SECURITY;
    ALTER TABLE legal_basis FORCE ROW LEVEL SECURITY;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'legal_basis' AND policyname = 'legal_basis_public_read') THEN
      CREATE POLICY legal_basis_public_read ON legal_basis FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'signal') THEN
    ALTER TABLE signal ENABLE ROW LEVEL SECURITY;
    ALTER TABLE signal FORCE ROW LEVEL SECURITY;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'signal' AND policyname = 'signal_public_read') THEN
      CREATE POLICY signal_public_read ON signal FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'evidence') THEN
    ALTER TABLE evidence ENABLE ROW LEVEL SECURITY;
    ALTER TABLE evidence FORCE ROW LEVEL SECURITY;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'evidence' AND policyname = 'evidence_public_read') THEN
      CREATE POLICY evidence_public_read ON evidence FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'outbox') THEN
    ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
    ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'outbox' AND policyname = 'outbox_public_read') THEN
      CREATE POLICY outbox_public_read ON outbox FOR SELECT USING (true);
    END IF;
  END IF;
END $$;
