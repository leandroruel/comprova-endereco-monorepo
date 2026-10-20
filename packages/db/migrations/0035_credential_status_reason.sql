SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- =====================================================================
-- FASE 24/C1: motivo auditável da revogação (ADR-0024, Revisão pós-PR #5)
-- =====================================================================
-- `credential_status` já guarda ACTIVE/REVOKED e `revoked_at`. O deep path
-- passa a revogar credenciais superadas quando produz uma conclusão nova
-- (veredito/evidências/policy/partial). O motivo fica persistido para auditoria
-- e não é exposto no endpoint público (que continua lendo só `status`).
--
-- Linhas REVOKED existentes ficam com NULL (motivo histórico desconhecido);
-- novas revogações gravam 'manual' ou 'superseded'. ACTIVE nunca tem motivo.

ALTER TABLE credential_status ADD COLUMN revocation_reason text;

ALTER TABLE credential_status
  ADD CONSTRAINT credential_status_reason_ck
  CHECK (
    (status = 'ACTIVE' AND revocation_reason IS NULL) OR
    (status = 'REVOKED')
  );

COMMENT ON COLUMN credential_status.revocation_reason IS
  'Motivo auditável da revogação: manual | superseded (não exposto publicamente)';
