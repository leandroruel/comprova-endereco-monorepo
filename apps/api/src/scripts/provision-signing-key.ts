import { createDbPool } from '@comprova/db'
import { createCLILogger } from '@comprova/observability'
import { provisionSigningKeys } from '../services/provision-signing-keys.js'
import { parseSigningKeys } from '../services/signing-keys.js'

/**
 * Provisiona `issuer_signing_key` (FASE 14) a partir de `CREDENTIAL_SIGNING_KEYS`
 * (ADR-0026).
 *
 * O material PRIVADO continua só na configuração; o que este comando faz é
 * PUBLICAR a chave pública correspondente, derivada dela, para cada par
 * (tenant, `key_id`) configurado. Rodar de novo é seguro e idempotente, e uma
 * chave JÁ publicada nunca é sobrescrita — trocar o material exige um novo
 * `key_id` (ver `provisionSigningKeys`).
 *
 * Usa a conexão de admin/owner (a mesma do seed): a aplicação só LÊ esta tabela.
 * O tenant precisa existir (FK); uma entrada para tenant inexistente falha alto.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) {
  throw new Error('DATABASE_ADMIN_URL is required')
}

const logger = createCLILogger('provision-signing-key')
const entries = parseSigningKeys(process.env.CREDENTIAL_SIGNING_KEYS ?? '[]')

const pool = createDbPool(adminUrl, { max: 1 })
try {
  const outcomes = await provisionSigningKeys(pool.db, entries, logger)
  logger.info({ keys: outcomes.length }, 'provisioning complete')
} finally {
  await pool.end()
}
