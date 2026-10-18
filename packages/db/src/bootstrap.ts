import { and, eq, inArray, isNull } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { createCLILogger } from '@comprova/observability'
import { createDbPool } from './client.js'
import { keyPrefixOf, makeApiKeyHasher, newApiKey } from './api-keys.js'
import * as t from './schema.js'

const logger = createCLILogger('bootstrap')

const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) {
  throw new Error('DATABASE_ADMIN_URL is required')
}
const pepper = process.env.API_KEY_PEPPER ?? 'dev-pepper-change-me'
const devTenantId = '00000000-0000-4000-8000-000000000001'

/** HMAC-SHA256 = 32 bytes; hash de outro tamanho veio de outra implementação. */
const HMAC_SHA256_BYTES = 32

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
      .select({ apiKeyId: t.apiKey.apiKeyId, keyHash: t.apiKey.keyHash })
      .from(t.apiKey)
      .where(and(eq(t.apiKey.tenantId, devTenantId), isNull(t.apiKey.revokedAt)))

    // Chave ativa que não é um HMAC de 32 bytes é resíduo do seed antigo (que
    // gravava argon2 enquanto a API compara HMAC): nunca autenticou. Sem
    // revogá-la, o seed sairia por "já tem chave ativa" e não haveria como
    // consertar — revoga e segue para emitir uma que funcione.
    const legacyKeys = activeKeys.filter((key) => key.keyHash.length !== HMAC_SHA256_BYTES)
    if (legacyKeys.length > 0) {
      await pool.db
        .update(t.apiKey)
        .set({ revokedAt: new Date() })
        .where(
          inArray(
            t.apiKey.apiKeyId,
            legacyKeys.map((key) => key.apiKeyId),
          ),
        )
      logger.info({ count: legacyKeys.length }, 'revoked legacy API key(s) from the old seed')
    }

    if (activeKeys.length > legacyKeys.length) {
      logger.info('dev tenant already has an active API key')
      return
    }

    const plaintext = newApiKey()
    const keyHash = makeApiKeyHasher(pepper).hash(plaintext)
    await pool.db.insert(t.apiKey).values({
      apiKeyId: randomUUID(),
      tenantId: devTenantId,
      keyPrefix: keyPrefixOf(plaintext),
      keyHash,
    })
    logger.info('API key created (will not be shown again):')
    process.stdout.write(`${plaintext}\n`)
  } finally {
    await pool.end()
  }
}

await run()
logger.info('bootstrap done')
