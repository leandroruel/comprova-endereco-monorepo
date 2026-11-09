import { createCLILogger } from '@comprova/observability'
import { defaultReferenceMigrationsDir, runMigrations } from './runner.js'

/**
 * Aplica as migrations do database de referência (CNEFE/Receita Federal).
 *
 *   pnpm db:migrate:reference
 *
 * Envs:
 *   REFERENCE_DATABASE_ADMIN_URL → database de referência (criado por
 *     `docker/postgres-init/01-create-reference.sql` ou `CREATE DATABASE`).
 *   APP_DB_PASSWORD              → senha do papel `app_user` (leitura).
 */
const logger = createCLILogger('migrate-reference')

const adminUrl = process.env.REFERENCE_DATABASE_ADMIN_URL
if (!adminUrl) {
  throw new Error('REFERENCE_DATABASE_ADMIN_URL is required')
}

await runMigrations({
  adminUrl,
  migrationsDir: defaultReferenceMigrationsDir(),
  rolePassword: process.env.APP_DB_PASSWORD,
})
logger.info('reference migrations applied')
