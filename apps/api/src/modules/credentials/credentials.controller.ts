import type { CredentialStatusDocument } from '@comprova/credential'
import { PROBLEM_CONTENT_TYPE, problems } from '@comprova/contracts'
import type { Db } from '@comprova/db'
import type { FastifyReply } from 'fastify'
import { revokeCredentialStatus } from '../../services/credential-status.js'

export interface CredentialsControllerDeps {
  readonly db: Db
}

/**
 * Revogação de credencial (ADR-0027). A rota é autenticada e o tenant vem do
 * API key; a consulta é escopada por RLS. Um `credential_id` de outro tenant é
 * indistinguível de um inexistente: 404, sem vazar a existência.
 */
export const makeCredentialsController = (deps: CredentialsControllerDeps) => ({
  revoke: async (
    tenant: { readonly tenantId: string } | undefined,
    credentialId: string,
    reply: FastifyReply,
  ): Promise<CredentialStatusDocument | FastifyReply> => {
    if (tenant === undefined) throw new Error('tenant context missing')
    const status = await revokeCredentialStatus(deps.db, tenant.tenantId, credentialId)
    if (status === null) {
      return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound('credential'))
    }
    return { status }
  },
})
