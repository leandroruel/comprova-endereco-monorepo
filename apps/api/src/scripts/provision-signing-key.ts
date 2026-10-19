import { createPublicKey, randomUUID } from 'node:crypto'
import { ed25519PublicKeyBytes, issuerScopeOf } from '@comprova/credential'
import { createDbPool } from '@comprova/db'
import * as t from '@comprova/db'
import { createCLILogger } from '@comprova/observability'
import { parseSigningKeys } from '../services/signing-keys.js'

/**
 * Provisiona `issuer_signing_key` (FASE 14) a partir de `CREDENTIAL_SIGNING_KEYS`
 * (ADR-0026).
 *
 * O material PRIVADO continua só na configuração; o que este comando faz é
 * PUBLICAR a chave pública correspondente, derivada dela, para cada par
 * (tenant, `key_id`) configurado. Rodar de novo ATUALIZA a chave publicada
 * (`onConflictDoUpdate` por `tenant_id` + `key_id`), sem tocar em `active` — a
 * rotação (marcar a antiga como inativa) é um passo administrativo futuro.
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
  for (const entry of entries) {
    const issuerScope = issuerScopeOf(entry.tenantId)
    const publicKey = ed25519PublicKeyBytes(createPublicKey(entry.privateKey))
    await pool.db
      .insert(t.issuerSigningKey)
      .values({
        issuerSigningKeyId: randomUUID(),
        tenantId: entry.tenantId,
        issuerScope,
        keyId: entry.keyId,
        algorithm: 'Ed25519',
        publicKey,
      })
      .onConflictDoUpdate({
        target: [t.issuerSigningKey.tenantId, t.issuerSigningKey.keyId],
        set: { issuerScope, algorithm: 'Ed25519', publicKey },
      })
    logger.info({ tenant_id: entry.tenantId, key_id: entry.keyId }, 'issuer signing key provisioned')
  }
  logger.info({ keys: entries.length }, 'provisioning complete')
} finally {
  await pool.end()
}
