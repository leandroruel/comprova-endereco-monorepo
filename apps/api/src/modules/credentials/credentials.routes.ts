import { CredentialStatusDocumentSchema } from '@comprova/credential'
import { ProblemSchema } from '@comprova/contracts'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { CredentialsControllerDeps } from './credentials.controller.js'
import { makeCredentialsController } from './credentials.controller.js'

export type CredentialRoutesDeps = CredentialsControllerDeps

/** `credential_id` opaco (43 chars base64url), o mesmo que aparece na VC. */
const RevokeCredentialParams = z.object({
  credentialId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})

/**
 * `POST /v1/credentials/:credentialId/revoke` — revogação monotônica,
 * autenticada e escopada pelo tenant. Não existe rota de reativação: a única
 * transição é ACTIVE → REVOKED (ADR-0027).
 */
export const registerCredentialRoutes = (instance: FastifyInstance, deps: CredentialRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeCredentialsController(deps)

  app.post(
    '/credentials/:credentialId/revoke',
    {
      schema: {
        params: RevokeCredentialParams,
        response: { 200: CredentialStatusDocumentSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => controller.revoke(request.tenant, request.params.credentialId, reply),
  )
}
