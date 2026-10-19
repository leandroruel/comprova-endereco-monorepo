import { randomUUID } from 'node:crypto'
import type { CommandHandler } from './types.js'

/** Cria um tenant com limites altos e imprime a chave de API em claro (uma vez). */
export const loadTenant: CommandHandler = async (context) => {
  const plaintext = await context.withDb(1, async (db) => {
    const { apiKey, makeApiKeyHasher, newApiKey, keyPrefixOf, tenant } = await import('@comprova/db')

    const tenantId = randomUUID()
    await db.insert(tenant).values({
      tenantId,
      name: 'load-tenant',
      rateLimitRps: 100_000,
      burst: 200_000,
    })

    const apiKeyPlaintext = newApiKey()
    await db.insert(apiKey).values({
      apiKeyId: randomUUID(),
      tenantId,
      keyPrefix: keyPrefixOf(apiKeyPlaintext),
      keyHash: makeApiKeyHasher(context.config.apiKeyPepper).hash(apiKeyPlaintext),
    })
    return apiKeyPlaintext
  })

  context.logger.info(plaintext)
}
