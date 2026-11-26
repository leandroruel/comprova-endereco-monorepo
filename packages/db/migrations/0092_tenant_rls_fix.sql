SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- ============================================================================
-- 0092 — Corrigir RLS na tabela tenant (introduzido incorretamente na 0074)
-- ============================================================================
-- A migration 0074 habilitou RLS na tabela tenant com apenas uma policy
-- de SELECT público, mas a tabela tenant é escrita pela aplicação (criação
-- de organizações). Sem policy de INSERT/UPDATE para app_user, a aplicação
-- falha com "new row violates row-level security policy".
-- Adicionamos as policies necessárias para app_user inserir/atualizar tenants.

-- Policy para INSERT: permite criar organizações (type = 'organization')
-- A validação de onboarding/termos acontece na aplicação.
CREATE POLICY tenant_app_user_insert ON tenant
  FOR INSERT
  TO app_user
  WITH CHECK (type = 'organization');

-- Policy para UPDATE: permite completar onboarding, aceitar termos, etc.
-- Apenas para organizations, e o tenant_id deve ser o do contexto.
CREATE POLICY tenant_app_user_update ON tenant
  FOR UPDATE
  TO app_user
  USING (type = 'organization' AND tenant_id = app_tenant_id())
  WITH CHECK (type = 'organization' AND tenant_id = app_tenant_id());

-- Policy para DELETE: não permitida (organizações são soft-delete via status)
-- Não criamos policy de DELETE.
