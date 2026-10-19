import { createPublicKey, randomUUID } from 'node:crypto'
import { ed25519PublicKeyBytes, issuerScopeOf } from '@comprova/credential'
import { and, eq, type Db } from '@comprova/db'
import * as t from '@comprova/db'
import type { Logger } from '@comprova/observability'
import type { SigningKeyEntry } from './signing-keys.js'

/**
 * Publicação da chave pública do issuer em `issuer_signing_key` (FASE 14),
 * separada do CLI para ser exercitada por teste.
 *
 * Duas invariantes que o startup depende:
 *
 * 1. **Nunca sobrescrever uma chave publicada.** Substituir a chave de um par
 *    (`tenant_id`, `key_id`) já publicado invalidaria as credenciais antigas
 *    assinadas por ela (o verificador resolve a pública por esse par). Se o
 *    material configurado mudou, o caminho é publicar sob um **novo `key_id`**;
 *    aqui isso é um erro alto, não uma sobrescrita silenciosa. O mesmo par com a
 *    MESMA chave pública é uma operação idempotente (repetir o provisionamento é
 *    seguro).
 * 2. **Preservar a chave ativa.** O índice parcial único
 *    (`issuer_signing_key_active_uq`) permite no máximo uma chave ativa por
 *    tenant. A primeira chave de um tenant vira ativa **só se** ele ainda não
 *    tiver nenhuma ativa — inclusive uma inserida nesta mesma execução — e
 *    qualquer chave adicional entra inativa. Assim, adicionar um `key_id` novo
 *    não colide no índice nem troca a chave que assina. Ativar a nova chave é um
 *    passo administrativo (rotação), fora do escopo deste passo.
 */
export class SigningKeyProvisioningError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SigningKeyProvisioningError'
  }
}

export interface ProvisioningOutcome {
  readonly tenantId: string
  readonly keyId: string
  /** `published` = inserida agora; `unchanged` = já publicada com a mesma chave. */
  readonly status: 'published' | 'unchanged'
  readonly active: boolean
}

export const provisionSigningKeys = async (
  db: Db,
  entries: readonly SigningKeyEntry[],
  logger: Logger,
): Promise<readonly ProvisioningOutcome[]> => {
  // Estado inicial: quem já tem chave ativa. Atualizado ao longo da execução
  // para que a primeira chave de cada tenant seja ativada e as demais não.
  const tenantsWithActiveKey = new Set(
    (
      await db
        .select({ tenantId: t.issuerSigningKey.tenantId })
        .from(t.issuerSigningKey)
        .where(eq(t.issuerSigningKey.active, true))
    ).map((row) => row.tenantId),
  )

  const outcomes: ProvisioningOutcome[] = []
  for (const entry of entries) {
    const publicKey = ed25519PublicKeyBytes(createPublicKey(entry.privateKey))

    const existing = (
      await db
        .select({ publicKey: t.issuerSigningKey.publicKey, active: t.issuerSigningKey.active })
        .from(t.issuerSigningKey)
        .where(
          and(eq(t.issuerSigningKey.tenantId, entry.tenantId), eq(t.issuerSigningKey.keyId, entry.keyId)),
        )
        .limit(1)
    )[0]

    if (existing !== undefined) {
      if (!Buffer.from(existing.publicKey).equals(publicKey)) {
        throw new SigningKeyProvisioningError(
          `issuer_signing_key already published a different public key for tenant ${entry.tenantId} key ${entry.keyId}; publish the new material under a NEW key_id instead of overwriting the published key`,
        )
      }
      logger.info(
        { tenant_id: entry.tenantId, key_id: entry.keyId },
        'issuer signing key already published (unchanged)',
      )
      outcomes.push({
        tenantId: entry.tenantId,
        keyId: entry.keyId,
        status: 'unchanged',
        active: existing.active,
      })
      continue
    }

    const active = !tenantsWithActiveKey.has(entry.tenantId)
    await db.insert(t.issuerSigningKey).values({
      issuerSigningKeyId: randomUUID(),
      tenantId: entry.tenantId,
      issuerScope: issuerScopeOf(entry.tenantId),
      keyId: entry.keyId,
      algorithm: 'Ed25519',
      publicKey,
      active,
    })
    if (active) tenantsWithActiveKey.add(entry.tenantId)
    logger.info({ tenant_id: entry.tenantId, key_id: entry.keyId, active }, 'issuer signing key published')
    outcomes.push({ tenantId: entry.tenantId, keyId: entry.keyId, status: 'published', active })
  }

  return outcomes
}
