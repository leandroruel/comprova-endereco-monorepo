import { hash } from '@node-rs/argon2'
import { and, eq, isNull } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { createCLILogger } from '@comprova/observability'
import { createDbPool } from './client.js'
import * as t from './schema.js'

const logger = createCLILogger('bootstrap')

const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) {
  throw new Error('DATABASE_ADMIN_URL is required')
}
const pepper = process.env.API_KEY_PEPPER ?? 'dev-pepper-change-me'
const devTenantId = '00000000-0000-4000-8000-000000000001'

const run = async (): Promise<void> => {
  const pool = createDbPool(adminUrl, { max: 1 })
  try {
    await pool.db
      .insert(t.legalBasis)
      .values([
        { code: 'FRAUD_PREVENTION', description: 'Prevencao a fraude (art. 7, II, LGPD)' },
        { code: 'CONTRACT_EXECUTION', description: 'Execucao de contrato (art. 7, V, LGPD)' },
        { code: 'CONSENT', description: 'Consentimento do titular (art. 7, I, LGPD)' },
      ])
      .onConflictDoNothing()

    await pool.db.insert(t.tenant).values({ tenantId: devTenantId, name: 'dev-tenant' }).onConflictDoNothing()

    const activeKeys = await pool.db
      .select({ apiKeyId: t.apiKey.apiKeyId })
      .from(t.apiKey)
      .where(and(eq(t.apiKey.tenantId, devTenantId), isNull(t.apiKey.revokedAt)))

    if (activeKeys.length > 0) {
      logger.info('dev tenant already has an active API key')
      return
    }

    const plaintext = `cvk${randomUUID().replace(/-/g, '')}`
    const keyHash = await hash(pepper + plaintext)
    await pool.db.insert(t.apiKey).values({
      apiKeyId: randomUUID(),
      tenantId: devTenantId,
      keyPrefix: plaintext.slice(0, 8),
      keyHash: Buffer.from(keyHash),
    })
    logger.info('API key created (will not be shown again):')
    process.stdout.write(`${plaintext}\n`)
  } finally {
    await pool.end()
  }
}

await run()
logger.info('bootstrap done')
