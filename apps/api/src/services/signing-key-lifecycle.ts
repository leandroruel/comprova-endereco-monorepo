import { and, eq, isNull, or, sql, withTenant, type Db } from '@comprova/db'
import * as t from '@comprova/db'

/**
 * Fronteira de ciclo de vida da chave de assinatura (ADR-0029).
 *
 * `active` continua com a semântica de ROTAÇÃO: uma chave `active = false`
 * deixou de assinar credenciais novas, mas segue publicada para verificar as
 * credenciais antigas. `revoked_at` é o hard stop independente: a partir dele a
 * chave deixa de ser confiável, sai dos documentos públicos e o verificador
 * falha fechado.
 *
 * A mesma condição é usada por três leitores para não haver divergência:
 * seleção da chave de emissão, provisionamento e documentos públicos.
 * `revoked_at` no futuro é uma expiração agendada; no passado, revogação.
 */
export const signingKeyTrustedCondition = () =>
  or(isNull(t.issuerSigningKey.revokedAt), sql`${t.issuerSigningKey.revokedAt} > now()`)

export interface RevokedSigningKey {
  readonly keyId: string
  readonly revokedAt: Date
}

/**
 * Revoga (ou agenda a expiração de) uma chave do tenant. `effectiveAt` no
 * futuro agenda; no passado revoga retroativamente; `undefined` usa o relógio
 * do PostgreSQL (`now()`), não o relógio da aplicação — a mesma referência
 * usada pela condição de confiança, sem janela de skew entre processos. A
 * operação é:
 *
 * - **monotônica no sentido de confiança**: um `revoked_at` futuro pode ser
 *   antecipado (revogação de emergência), mas nunca adiado nem desfeito. Um
 *   pedido com instante mais cedo que o registrado o substitui; um pedido com
 *   instante igual ou mais tarde devolve o já registrado;
 * - **idempotente**: repetir devolve o instante efetivo;
 * - **escopada por RLS**: a chave de outro tenant é indistinguível de uma
 *   inexistente (`null` → 404), sem vazar a existência.
 *
 * O `UPDATE` usa a mesma serialização por row lock do status de credencial; o
 * trigger `issuer_signing_key_guard` (migration 0033) é a barreira final contra
 * adiar/desfazer a revogação ou reescrever a identidade da chave.
 */
export const revokeSigningKey = async (
  db: Db,
  tenantId: string,
  keyId: string,
  effectiveAt: Date | undefined,
): Promise<RevokedSigningKey | null> =>
  withTenant(db, tenantId, async (tx) => {
    const target = effectiveAt ?? sql`now()`
    // Na comparação crua o Drizzle não conhece o tipo da coluna e não converte
    // `Date`; o ISO-8601 é aceito pelo timestamptz. No `SET`, a coluna tipada
    // faz a conversão.
    const boundary = effectiveAt === undefined ? sql`now()` : effectiveAt.toISOString()
    const updated = await tx
      .update(t.issuerSigningKey)
      .set({ revokedAt: target })
      .where(
        and(
          eq(t.issuerSigningKey.tenantId, tenantId),
          eq(t.issuerSigningKey.keyId, keyId),
          or(isNull(t.issuerSigningKey.revokedAt), sql`${t.issuerSigningKey.revokedAt} > ${boundary}`),
        ),
      )
      .returning({ keyId: t.issuerSigningKey.keyId, revokedAt: t.issuerSigningKey.revokedAt })
    const revoked = updated[0]
    if (revoked !== undefined && revoked.revokedAt !== null) {
      return { keyId: revoked.keyId, revokedAt: revoked.revokedAt }
    }

    const rows = await tx
      .select({ keyId: t.issuerSigningKey.keyId, revokedAt: t.issuerSigningKey.revokedAt })
      .from(t.issuerSigningKey)
      .where(and(eq(t.issuerSigningKey.tenantId, tenantId), eq(t.issuerSigningKey.keyId, keyId)))
      .limit(1)
    const existing = rows[0]
    return existing === undefined || existing.revokedAt === null
      ? null
      : { keyId: existing.keyId, revokedAt: existing.revokedAt }
  })
