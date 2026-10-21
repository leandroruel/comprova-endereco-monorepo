import { randomUUID } from 'node:crypto'
import { issuerScopeOf } from '@comprova/credential'
import { and, eq, sql, type Db } from '@comprova/db'
import * as t from '@comprova/db'
import type { Logger } from '@comprova/observability'
import { kmsKeyReferenceOf, publicKeyOf, type SigningKeyEntry } from './signing-keys.js'

/**
 * Rotação de chave de assinatura (roadmap #24, etapa 24.2; ADR-0026/ADR-0029).
 *
 * `superseded ≠ revoked`. A rotação só mexe no eixo `active`:
 *
 *   active = true   → assina credenciais novas
 *   active = false  → SUPERADA: não assina mais, mas continua PUBLICADA para o
 *                     verificador resolver as credenciais antigas
 *
 * `revoked_at` (o hard stop, ADR-0029) NUNCA é tocado aqui: revogar é uma
 * decisão de confiança, separada de rotacionar. Uma chave superada continua
 * confiável para o passado até que alguém a revogue explicitamente.
 *
 * A entrada pode ser local ou AWS KMS (ADR-0032). Para KMS, a pública já vem
 * resolvida com `GetPublicKey` e a referência canônica é persistida junto; a
 * privada nunca sai do KMS.
 *
 * Quem executa é a operação ADMINISTRATIVA (conexão owner, como o
 * provisionamento): a aplicação só LÊ `issuer_signing_key` e atualiza
 * `revoked_at` (grants por coluna, ADR-0029). Não existe endpoint público de
 * rotação nesta etapa; a operação de domínio é a superfície testável.
 *
 * O provider de assinatura (etapa 24.1) NÃO participa: ele recebe a chave já
 * selecionada por `loadActiveSigningKey`. Rotacionar é decidir QUAL chave está
 * ativa; assinar é outra responsabilidade.
 */

export class SigningKeyRotationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SigningKeyRotationError'
  }
}

export interface SigningKeyRotationOutcome {
  readonly tenantId: string
  /** Chave que passou a assinar. */
  readonly keyId: string
  /** Chave que deixou de assinar; `null` quando não havia nenhuma ativa (ou no-op). */
  readonly previousKeyId: string | null
  /** `rotated` = trocou a chave ativa; `unchanged` = já era esta a chave ativa. */
  readonly status: 'rotated' | 'unchanged'
}

/**
 * Rotaciona a chave ativa do tenant para `entry`, de forma ATÔMICA e
 * concorrente-segura:
 *
 * ```text
 * BEGIN
 *   pg_advisory_xact_lock(tenant)   -- serializa rotações do MESMO tenant
 *   1. conflitos/idempotência sobre o `key_id` alvo
 *   2. active = false na chave ativa atual   (nunca toca revoked_at)
 *   3. INSERT da nova chave com active = true
 * COMMIT
 * ```
 *
 * **Atomicidade**: tudo numa transação. Uma falha no meio (constraint, timeout)
 * desfaz o `UPDATE` também — o tenant nunca fica sem chave utilizável nem com
 * duas ativas.
 *
 * **Concorrência**: o lock de transação por tenant serializa `rotate` vs
 * `rotate`; a segunda espera a primeira commitar e enxerga o estado novo. O
 * índice parcial único `issuer_signing_key_active_uq` (`tenant_id WHERE active`)
 * é a segunda barreira: mesmo sem o lock, o banco não admite duas ativas. Não é
 * um `if (active)` na aplicação.
 *
 * **Idempotência**: rotacionar para a chave que JÁ é a ativa (mesmo material) é
 * no-op (`unchanged`). Reusar um `key_id` já publicado com material DIFERENTE,
 * reativar uma chave SUPERADA ou reusar o material de outra chave são erros
 * altos — nunca uma sobrescrita silenciosa.
 *
 * `entry` traz o material PRIVADO (como no provisionamento): a chave pública
 * publicada é derivada dele, então é impossível publicar uma pública que não
 * corresponda ao que o provider vai usar para assinar.
 */
export const rotateSigningKey = async (
  db: Db,
  entry: SigningKeyEntry,
  logger: Logger,
): Promise<SigningKeyRotationOutcome> => {
  const publicKey = publicKeyOf(entry)
  const kmsKeyReference = kmsKeyReferenceOf(entry)
  const lockKey = `comprova-signing-key-rotate:${entry.tenantId}`

  return db.transaction(async (tx) => {
    // Os timeouts valem para TODA espera de lock, inclusive o advisory lock
    // abaixo: definir depois deixaria a aquisição do advisory lock esperando
    // indefinidamente por outra rotação. Falha fechado em 3s.
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`)
    await tx.execute(sql`SET LOCAL statement_timeout = '10s'`)
    // Serializa rotações do mesmo tenant (mesmo padrão do runner de migrations).
    // Segura até o fim da transação, quando a próxima rotação enxerga o estado
    // já rotacionado. Conflito de hash entre tenants só reduz concorrência.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`)

    const published = (
      await tx
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

    if (published !== undefined) {
      if (!Buffer.from(published.publicKey).equals(publicKey)) {
        throw new SigningKeyRotationError(
          `issuer_signing_key already published a different public key for tenant ${entry.tenantId} key ${entry.keyId}; a published key is never overwritten`,
        )
      }
      if (published.kmsKeyReference !== kmsKeyReference) {
        throw new SigningKeyRotationError(
          `issuer_signing_key already published tenant ${entry.tenantId} key ${entry.keyId} with a different signing backend reference; a published key is never overwritten`,
        )
      }
      if (published.active) {
        // Já é a chave que assina: repetir a rotação é seguro (no-op).
        return { tenantId: entry.tenantId, keyId: entry.keyId, previousKeyId: null, status: 'unchanged' }
      }
      throw new SigningKeyRotationError(
        `issuer_signing_key key ${entry.keyId} for tenant ${entry.tenantId} is superseded; reusing a superseded key_id would resurrect a retired key — rotate to a NEW key_id`,
      )
    }

    // Não reutilizar o material de outra chave: o mesmo par público não pode
    // viver sob dois `key_id` do tenant. Sob o lock, a checagem é determinística.
    const reused = (
      await tx
        .select({ keyId: t.issuerSigningKey.keyId })
        .from(t.issuerSigningKey)
        .where(
          and(eq(t.issuerSigningKey.tenantId, entry.tenantId), eq(t.issuerSigningKey.publicKey, publicKey)),
        )
        .limit(1)
    )[0]
    if (reused !== undefined) {
      throw new SigningKeyRotationError(
        `issuer_signing_key already publishes this public key for tenant ${entry.tenantId} under key ${reused.keyId}; rotation must use new key material`,
      )
    }

    const current = (
      await tx
        .select({ keyId: t.issuerSigningKey.keyId })
        .from(t.issuerSigningKey)
        .where(and(eq(t.issuerSigningKey.tenantId, entry.tenantId), eq(t.issuerSigningKey.active, true)))
        .limit(1)
    )[0]

    // Rotação: a ativa atual vira SUPERADA. Só `active` muda — o trigger
    // (`issuer_signing_key_guard`) permite e `revoked_at` fica intacto.
    if (current !== undefined) {
      await tx
        .update(t.issuerSigningKey)
        .set({ active: false })
        .where(and(eq(t.issuerSigningKey.tenantId, entry.tenantId), eq(t.issuerSigningKey.active, true)))
    }

    await tx.insert(t.issuerSigningKey).values({
      issuerSigningKeyId: randomUUID(),
      tenantId: entry.tenantId,
      issuerScope: issuerScopeOf(entry.tenantId),
      keyId: entry.keyId,
      algorithm: 'Ed25519',
      publicKey,
      kmsKeyReference,
      active: true,
    })

    logger.info(
      { tenant_id: entry.tenantId, key_id: entry.keyId, previous_key_id: current?.keyId ?? null },
      'issuer signing key rotated',
    )
    return {
      tenantId: entry.tenantId,
      keyId: entry.keyId,
      previousKeyId: current?.keyId ?? null,
      status: 'rotated',
    }
  })
}
