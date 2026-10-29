SET lock_timeout = '5s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'comprova-migrations';

-- Plugin admin do Better Auth: colunas de moderação/ban e impersonação.
-- `role` foi adicionado em 0047; estas são as demais colunas do plugin.
ALTER TABLE "user" ADD COLUMN banned boolean NOT NULL DEFAULT false;
ALTER TABLE "user" ADD COLUMN ban_reason text;
ALTER TABLE "user" ADD COLUMN ban_expires timestamptz;
ALTER TABLE "session" ADD COLUMN impersonated_by text;

GRANT UPDATE (banned, ban_reason, ban_expires) ON "user" TO app_user;
GRANT UPDATE (impersonated_by) ON "session" TO app_user;
