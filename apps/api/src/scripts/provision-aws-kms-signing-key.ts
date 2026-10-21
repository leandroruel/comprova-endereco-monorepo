import { KeyIdSchema } from '@comprova/credential'
import { createDbPool } from '@comprova/db'
import { createCLILogger } from '@comprova/observability'
import { z } from 'zod'
import { makeAwsKmsClient, readAwsKmsPublicKeyFromClient } from '../services/aws-kms-signing-key-provider.js'
import { provisionSigningKeys } from '../services/provision-signing-keys.js'
import type { SigningKeyEntry } from '../services/signing-keys.js'

/**
 * Provisiona uma signing key cujo material privado vive no AWS KMS (roadmap
 * #24, etapa 24.3; ADR-0032).
 *
 * Uso: `pnpm db:provision-kms-key <tenant_id> <key_id> <kms_key_reference>`.
 *
 * O comando NÃO migra chaves existentes: é uma operação explícita por chave.
 * Lê a pública com `GetPublicKey` (nunca a privada), grava os 32 bytes crus em
 * `issuer_signing_key.public_key` e o ARN canônico em `kms_key_reference`.
 * Passar um alias é aceito, mas o ARN devolvido pelo KMS é o que fica
 * persistido — um alias repontado depois não troca a chave publicada.
 *
 * Requer `kms:GetPublicKey` na chave. Usa a conexão admin/owner (a aplicação só
 * lê a tabela); o tenant precisa existir (FK).
 */
const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) {
  throw new Error('DATABASE_ADMIN_URL is required')
}

const [tenantIdRaw, keyIdRaw, kmsKeyReferenceRaw] = process.argv.slice(2)
if (!tenantIdRaw || !keyIdRaw || !kmsKeyReferenceRaw) {
  throw new Error('usage: provision-aws-kms-signing-key <tenant_id> <key_id> <kms_key_reference>')
}

const tenantId = z.uuid().parse(tenantIdRaw).toLowerCase()
const keyId = KeyIdSchema.parse(keyIdRaw)
const kmsKeyReference = z.string().trim().min(1).parse(kmsKeyReferenceRaw)
const region = process.env.AWS_KMS_REGION?.trim() || undefined

const logger = createCLILogger('provision-aws-kms-signing-key')
const client = makeAwsKmsClient(region)
try {
  const resolved = await readAwsKmsPublicKeyFromClient(client, kmsKeyReference)
  const entry: SigningKeyEntry = {
    kind: 'kms',
    tenantId,
    keyId,
    kmsKeyReference: resolved.keyReference,
    publicKey: resolved.publicKey,
  }

  const pool = createDbPool(adminUrl, { max: 1 })
  try {
    const outcomes = await provisionSigningKeys(pool.db, [entry], logger)
    logger.info({ keys: outcomes.length, kms_key_reference: resolved.keyReference }, 'provisioning complete')
  } finally {
    await pool.end()
  }
} finally {
  client.destroy()
}
