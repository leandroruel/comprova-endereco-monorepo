import { randomUUID } from 'node:crypto'
import { issuerScopeOf } from '@comprova/credential'
import { and, eq, isNotNull, lte, sql, type Db } from '@comprova/db'
import * as t from '@comprova/db'
import type { Logger } from '@comprova/observability'
import { kmsKeyReferenceOf, publicKeyOf, type SigningKeyEntry } from './signing-keys.js'
import { signingKeyTrustedCondition } from './signing-key-lifecycle.js'

/**
 * Publicação da chave pública do issuer em `issuer_signing_key` (FASE 14),
 * separada do CLI para ser exercitada por teste. Aceita entradas locais
 * (privada em memória) e KMS (pública já lida com `GetPublicKey`); em ambos, a
 * referência externa (`kms_key_reference`) entra na identidade publicada
 * (ADR-0032).
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
 *    tiver nenhuma ativa **e confiável** — inclusive uma inserida nesta mesma
 *    execução — e qualquer chave adicional entra inativa. Assim, adicionar um
 *    `key_id` novo não colide no índice nem troca a chave que assina. Ativar a
 *    nova chave é um passo administrativo (rotação), fora do escopo deste passo.
 *
 * `revoked_at` (ADR-0029) é um eixo separado: uma chave ativa revogada/vencida
 * não conta como ativa para a decisão acima. Provisionar um `key_id` novo
 * depois da revogação da única chave ativa faz a nova chave nascer ativa; uma
 * chave já publicada nunca é "desrevogada" nem reativada por este comando.
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
  // Estado inicial: quem já tem chave ativa E confiável. Atualizado ao longo da
  // execução para que a primeira chave de cada tenant seja ativada e as demais
  // não. Uma chave ativa revogada/vencida não entra no conjunto (ADR-0029).
  const tenantsWithActiveKey = new Set(
    (
      await db
        .select({ tenantId: t.issuerSigningKey.tenantId })
        .from(t.issuerSigningKey)
        .where(and(eq(t.issuerSigningKey.active, true), signingKeyTrustedCondition()))
    ).map((row) => row.tenantId),
  )

  const outcomes: ProvisioningOutcome[] = []
  for (const entry of entries) {
    const publicKey = publicKeyOf(entry)
    const kmsKeyReference = kmsKeyReferenceOf(entry)

    const existing = (
      await db
        .select({
          publicKey: t.issuerSigningKey.publicKey,
          active: t.issuerSigningKey.active,
          kmsKeyReference: t.issuerSigningKey.kmsKeyReference,
        })
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
      // A referência externa também faz parte da identidade da chave: trocar
      // local ↔ KMS (ou apontar para outra chave KMS) com a mesma pública
      // mudaria o backend que assina sem alterar o verificationMethod.
      if (existing.kmsKeyReference !== kmsKeyReference) {
        throw new SigningKeyProvisioningError(
          `issuer_signing_key already published tenant ${entry.tenantId} key ${entry.keyId} with a different signing backend reference; publish the new material under a NEW key_id`,
        )
      }
      logger.info(
        {
          tenant_id: entry.tenantId,
          key_id: entry.keyId,
          backend: entry.kind,
        },
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
    if (active) {
      // Uma chave ativa revogada/vencida ainda ocupa o índice parcial único
      // (`... WHERE active`). Desativá-la é seguro: ela já não é confiável e
      // continua no histórico com o `revoked_at` intacto; o trigger permite
      // alterar `active`, mas não reescrever a revogação. Sem esta limpeza, a
      // inserção de uma nova chave ativa colidiria com a revogada.
      await db
        .update(t.issuerSigningKey)
        .set({ active: false })
        .where(
          and(
            eq(t.issuerSigningKey.tenantId, entry.tenantId),
            eq(t.issuerSigningKey.active, true),
            isNotNull(t.issuerSigningKey.revokedAt),
            lte(t.issuerSigningKey.revokedAt, sql`now()`),
          ),
        )
    }
    await db.insert(t.issuerSigningKey).values({
      issuerSigningKeyId: randomUUID(),
      tenantId: entry.tenantId,
      issuerScope: issuerScopeOf(entry.tenantId),
      keyId: entry.keyId,
      algorithm: 'Ed25519',
      publicKey,
      kmsKeyReference,
      active,
    })
    if (active) tenantsWithActiveKey.add(entry.tenantId)
    logger.info(
      {
        tenant_id: entry.tenantId,
        key_id: entry.keyId,
        active,
        backend: entry.kind,
      },
      'issuer signing key published',
    )
    outcomes.push({ tenantId: entry.tenantId, keyId: entry.keyId, status: 'published', active })
  }

  return outcomes
}
