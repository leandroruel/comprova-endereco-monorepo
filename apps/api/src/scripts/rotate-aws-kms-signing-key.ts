import { KeyIdSchema } from '@comprova/credential'
import { createDbPool } from '@comprova/db'
import { createCLILogger } from '@comprova/observability'
import { z } from 'zod'
import { makeAwsKmsClient, readAwsKmsPublicKeyFromClient } from '../services/aws-kms-signing-key-provider.js'
import { rotateSigningKey } from '../services/signing-key-rotation.js'
import type { SigningKeyEntry } from '../services/signing-keys.js'

/**
 * Rotaciona a chave ativa de um tenant para uma chave Ed25519 do AWS KMS
 * (roadmap #24, etapa 24.3; ADR-0032).
 *
 * Uso: `pnpm db:rotate-kms-key <tenant_id> <new_key_id> <kms_key_reference>`.
 *
 * Como a rotação local, a chave ativa atual vira SUPERADA (`active = false`,
 * sem revogar) e a nova é publicada/ativada na mesma transação. A pública é
 * lida do KMS com `GetPublicKey`; a privada nunca sai do KMS. O ARN canônico
 * devolvido pelo KMS é o persistido em `kms_key_reference`.
 *
 * Requer `kms:GetPublicKey` na chave. A assinatura em si exige `kms:Sign`,
 * concedido ao papel da API (não a este comando).
 */
const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) {
  throw new Error('DATABASE_ADMIN_URL is required')
}

const [tenantIdRaw, keyIdRaw, kmsKeyReferenceRaw] = process.argv.slice(2)
if (!tenantIdRaw || !keyIdRaw || !kmsKeyReferenceRaw) {
  throw new Error('usage: rotate-aws-kms-signing-key <tenant_id> <new_key_id> <kms_key_reference>')
}

const tenantId = z.uuid().parse(tenantIdRaw).toLowerCase()
const keyId = KeyIdSchema.parse(keyIdRaw)
const kmsKeyReference = z.string().trim().min(1).parse(kmsKeyReferenceRaw)
const region = process.env.AWS_KMS_REGION?.trim() || undefined

const logger = createCLILogger('rotate-aws-kms-signing-key')
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
    const outcome = await rotateSigningKey(pool.db, entry, logger)
    logger.info(
      {
        status: outcome.status,
        tenant_id: outcome.tenantId,
        key_id: outcome.keyId,
        previous_key_id: outcome.previousKeyId,
        kms_key_reference: resolved.keyReference,
      },
      'rotation complete',
    )
  } finally {
    await pool.end()
  }
} finally {
  client.destroy()
}
