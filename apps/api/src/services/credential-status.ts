import type { CredentialStatusValue } from '@comprova/credential'
import { and, eq, sql, withTenant, type Db, type DbTx } from '@comprova/db'
import * as t from '@comprova/db'

/**
 * Fronteira de persistência do status da credencial (ADR-0027).
 *
 * A credencial em si continua NÃO persistida: só o estado ACTIVE/REVOKED por
 * `credential_id` público. As escritas são escopadas por RLS (`withTenant`); a
 * leitura pública seleciona apenas `status` e usa a policy `public_status_read`.
 */

/**
 * Registra a credencial como ACTIVE na emissão. Idempotente: reemitir a mesma
 * validation encontra a linha existente e NÃO a reativa (se estiver REVOKED,
 * continua REVOKED — revogação é monotônica).
 *
 * A checagem de identidade após um conflito é defesa em profundidade: o
 * `credential_id` já inclui o `issuer.id`, então uma colisão entre tenants é
 * computacionalmente inviável; ainda assim, nunca aceitamos uma linha de outro
 * tenant/escopo para a mesma credencial.
 */
export const ensureActiveCredentialStatusInTx = async (
  tx: DbTx,
  tenantId: string,
  issuerScope: string,
  credentialId: string,
): Promise<void> => {
  const inserted = await tx
    .insert(t.credentialStatus)
    .values({
      credentialId,
      tenantId,
      issuerScope,
      status: 'ACTIVE',
    })
    .onConflictDoNothing()
    .returning({ credentialId: t.credentialStatus.credentialId })

  if (inserted.length > 0) return

  const rows = await tx
    .select({
      tenantId: t.credentialStatus.tenantId,
      issuerScope: t.credentialStatus.issuerScope,
    })
    .from(t.credentialStatus)
    .where(eq(t.credentialStatus.credentialId, credentialId))
    .limit(1)
  const existing = rows[0]
  if (existing === undefined || existing.tenantId !== tenantId || existing.issuerScope !== issuerScope) {
    throw new Error(`credential status identity conflict for credential ${credentialId}`)
  }
}

export const ensureActiveCredentialStatus = async (
  db: Db,
  tenantId: string,
  issuerScope: string,
  credentialId: string,
): Promise<void> => {
  await withTenant(db, tenantId, (tx) =>
    ensureActiveCredentialStatusInTx(tx, tenantId, issuerScope, credentialId),
  )
}

/**
 * Persiste a PRIMEIRA emissão da validation e garante o status ACTIVE, na
 * MESMA transação. Em replay, devolve o `issued_at` original e não reativa uma
 * credencial REVOKED. `now` só é lido quando não existe linha: o instante da
 * primeira prova é imutável.
 *
 * Não guarda o documento assinado; só `issued_at` e o ponteiro de status
 * (`credential_id`). A reemissão usa `issued_at` como `proof.created`.
 */
export const ensureFirstCredentialIssuance = async (
  db: Db,
  tenantId: string,
  issuerScope: string,
  validationId: string,
  credentialId: string,
  now: () => Date,
): Promise<Date> => {
  return withTenant(db, tenantId, async (tx) => {
    const read = () =>
      tx
        .select({
          tenantId: t.credentialIssuance.tenantId,
          issuerScope: t.credentialIssuance.issuerScope,
          credentialId: t.credentialIssuance.credentialId,
          issuedAt: t.credentialIssuance.issuedAt,
        })
        .from(t.credentialIssuance)
        .where(eq(t.credentialIssuance.validationId, validationId))
        .limit(1)

    const verify = (existing: {
      readonly tenantId: string
      readonly issuerScope: string
      readonly credentialId: string
      readonly issuedAt: Date
    }): Date => {
      if (
        existing.tenantId !== tenantId ||
        existing.issuerScope !== issuerScope ||
        existing.credentialId !== credentialId
      ) {
        throw new Error(`credential issuance identity conflict for validation ${validationId}`)
      }
      return existing.issuedAt
    }

    const rows = await read()
    const existing = rows[0]
    if (existing !== undefined) {
      await ensureActiveCredentialStatusInTx(tx, tenantId, issuerScope, credentialId)
      return verify(existing)
    }

    const first = now()
    const inserted = await tx
      .insert(t.credentialIssuance)
      .values({
        validationId,
        tenantId,
        issuerScope,
        credentialId,
        issuedAt: first,
      })
      .onConflictDoNothing()
      .returning({ issuedAt: t.credentialIssuance.issuedAt })

    // Corrida entre duas primeiras emissões: quem perdeu lê o instante do
    // vencedor e confere a identidade. Nunca se sobrescreve `issued_at`.
    let issuedAt: Date
    if (inserted[0] !== undefined) {
      issuedAt = inserted[0].issuedAt
    } else {
      const raced = (await read())[0]
      if (raced === undefined) {
        throw new Error(`credential issuance for validation ${validationId} was not persisted`)
      }
      issuedAt = verify(raced)
    }
    await ensureActiveCredentialStatusInTx(tx, tenantId, issuerScope, credentialId)
    return issuedAt
  })
}

/**
 * Revoga uma credencial do tenant. Retorna o status atual (`REVOKED`) ou `null`
 * quando a credencial não existe para este tenant — o chamador responde 404,
 * sem distinguir "inexistente" de "de outro tenant".
 *
 * A atualização só casa `status = 'ACTIVE'`; duas revogações concorrentes são
 * serializadas pelo row lock e a segunda encontra 0 linhas, mas a leitura
 * seguinte devolve REVOKED (idempotência). O trigger `credential_status_guard`
 * é a última barreira contra REVOKED → ACTIVE.
 */
export const revokeCredentialStatus = async (
  db: Db,
  tenantId: string,
  credentialId: string,
  reason: 'manual' | 'superseded' = 'manual',
): Promise<CredentialStatusValue | null> =>
  withTenant(db, tenantId, async (tx) => {
    const updated = await tx
      .update(t.credentialStatus)
      .set({ status: 'REVOKED', revokedAt: sql`now()`, revocationReason: reason })
      .where(
        and(
          eq(t.credentialStatus.tenantId, tenantId),
          eq(t.credentialStatus.credentialId, credentialId),
          eq(t.credentialStatus.status, 'ACTIVE'),
        ),
      )
      .returning({ status: t.credentialStatus.status })
    const revoked = updated[0]
    if (revoked !== undefined) return revoked.status

    const rows = await tx
      .select({ status: t.credentialStatus.status })
      .from(t.credentialStatus)
      .where(
        and(eq(t.credentialStatus.tenantId, tenantId), eq(t.credentialStatus.credentialId, credentialId)),
      )
      .limit(1)
    return rows[0]?.status ?? null
  })

/**
 * Leitura pública usada pelo endpoint de status. Não define `app.tenant_id`:
 * depende da policy `public_status_read` e seleciona SOMENTE o status. O par
 * (issuer_scope, credential_id) amarra a credencial ao issuer público.
 */
export const loadPublicCredentialStatus = async (
  db: Db,
  issuerScope: string,
  credentialId: string,
): Promise<CredentialStatusValue | null> => {
  const rows = await db
    .select({ status: t.credentialStatus.status })
    .from(t.credentialStatus)
    .where(
      and(eq(t.credentialStatus.issuerScope, issuerScope), eq(t.credentialStatus.credentialId, credentialId)),
    )
    .limit(1)
  return rows[0]?.status ?? null
}
