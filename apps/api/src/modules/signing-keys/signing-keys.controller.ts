import type { IssuerSigningKeyRevocation } from '@comprova/credential'
import { PROBLEM_CONTENT_TYPE, problems } from '@comprova/contracts'
import type { Db } from '@comprova/db'
import type { FastifyReply } from 'fastify'
import type { TenantContext } from '../../plugins/auth.js'
import { revokeSigningKey } from '../../services/signing-key-lifecycle.js'

export interface SigningKeysControllerDeps {
  readonly db: Db
}

/**
 * Revogação/expiração de chave de assinatura (ADR-0029). A rota é autenticada
 * e o tenant vem do API key; a consulta é escopada por RLS. Um `key_id` de
 * outro tenant é indistinguível de um inexistente: 404, sem vazar a existência.
 *
 * A revogação é uma operação ADMINISTRATIVA: a rota exige `keys:write` no
 * `preHandler` (`requireKeysWriteScope`), separado de `validate:write`. Uma
 * chave usada para emitir credenciais não pode derrubar a chave de assinatura
 * do tenant. O 403 é decidido antes do handler e não revela se o `key_id`
 * existe.
 *
 * `effective_at` ausente significa revogação imediata (`now()` no banco). Um
 * instante futuro agenda a expiração; a chave continua publicada e utilizável
 * até lá. A resposta é idempotente: repetir devolve o instante efetivo, e um
 * instante mais cedo antecipa a revogação; nunca a adia.
 */
export const makeSigningKeysController = (deps: SigningKeysControllerDeps) => ({
  revoke: async (
    tenant: TenantContext | undefined,
    keyId: string,
    effectiveAt: string | undefined,
    reply: FastifyReply,
  ): Promise<IssuerSigningKeyRevocation | FastifyReply> => {
    if (tenant === undefined) throw new Error('tenant context missing')
    const revoked = await revokeSigningKey(
      deps.db,
      tenant.tenantId,
      keyId,
      effectiveAt === undefined ? undefined : new Date(effectiveAt),
    )
    if (revoked === null) {
      return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound('signing key'))
    }
    return { key_id: revoked.keyId, revoked_at: revoked.revokedAt.toISOString() }
  },
})
