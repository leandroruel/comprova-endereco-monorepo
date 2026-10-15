import { createCLILogger } from '@comprova/observability'
import { runMigrations } from './runner.js'

const logger = createCLILogger('migrate')

const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) {
  throw new Error('DATABASE_ADMIN_URL is required')
}

await runMigrations({ adminUrl, rolePassword: process.env.APP_DB_PASSWORD })
logger.info('migrations applied')
