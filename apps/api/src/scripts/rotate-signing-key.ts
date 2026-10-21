import { createDbPool } from '@comprova/db'
import { createCLILogger } from '@comprova/observability'
import { rotateSigningKey } from '../services/signing-key-rotation.js'
import { parseSigningKeys } from '../services/signing-keys.js'

/**
 * Rotaciona a chave de assinatura ATIVA de um tenant (ADR-0026/ADR-0029,
 * roadmap #24 etapa 24.2).
 *
 * Uso: `pnpm db:rotate-key <tenant_id> <new_key_id>`. O `new_key_id` precisa já
 * estar em `CREDENTIAL_SIGNING_KEYS` (o material privado continua só na
 * configuração; é dele que a pública é derivada). A operação é atômica: a chave
 * ativa atual vira SUPERADA (`active = false`, sem revogar) e a nova é publicada
 * e ativada. Rodar de novo com a chave já ativa é no-op.
 *
 * Usa a conexão de admin/owner (a mesma do seed/provisionamento): a aplicação só
 * LÊ esta tabela e atualiza `revoked_at`.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) {
  throw new Error('DATABASE_ADMIN_URL is required')
}

const [tenantIdRaw, keyId] = process.argv.slice(2)
if (!tenantIdRaw || !keyId) {
  throw new Error('usage: rotate-signing-key <tenant_id> <new_key_id>')
}

const logger = createCLILogger('rotate-signing-key')
const tenantId = tenantIdRaw.toLowerCase()
const entry = parseSigningKeys(process.env.CREDENTIAL_SIGNING_KEYS ?? '[]').find(
  (candidate) => candidate.tenantId === tenantId && candidate.keyId === keyId,
)
if (entry === undefined) {
  throw new Error(
    `no configured signing material for tenant ${tenantId} key ${keyId}; add it to CREDENTIAL_SIGNING_KEYS first`,
  )
}

const pool = createDbPool(adminUrl, { max: 1 })
try {
  const outcome = await rotateSigningKey(pool.db, entry, logger)
  logger.info(
    {
      status: outcome.status,
      tenant_id: outcome.tenantId,
      key_id: outcome.keyId,
      previous_key_id: outcome.previousKeyId,
    },
    'rotation complete',
  )
} finally {
  await pool.end()
}
