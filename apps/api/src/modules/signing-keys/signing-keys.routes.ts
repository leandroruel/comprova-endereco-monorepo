import { IssuerSigningKeyRevocationSchema, KeyIdSchema } from '@comprova/credential'
import { ProblemSchema } from '@comprova/contracts'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireKeysWriteScope } from '../../plugins/scope.js'
import type { SigningKeysControllerDeps } from './signing-keys.controller.js'
import { makeSigningKeysController } from './signing-keys.controller.js'

export type SigningKeyRoutesDeps = SigningKeysControllerDeps

/** `key_id` é um fragmento válido, não um UUID: validado como na configuração. */
const RevokeSigningKeyParams = z.object({ keyId: KeyIdSchema })

/**
 * `effective_at` ausente = revogação imediata. Um instante futuro agenda a
 * expiração (mesmo eixo de `revoked_at`); não existe rota de reativação, porque
 * a transição é monotônica (ADR-0029).
 */
const RevokeSigningKeyQuery = z.object({
  effective_at: z.iso.datetime().optional(),
})

/**
 * `POST /v1/signing-keys/:keyId/revoke` — revogação monotônica, autenticada e
 * escopada pelo tenant. Distinta da rotação (`active = false`): a chave
 * revogada deixa de ser confiável para credenciais novas E antigas.
 */
export const registerSigningKeyRoutes = (instance: FastifyInstance, deps: SigningKeyRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeSigningKeysController(deps)

  app.post(
    '/signing-keys/:keyId/revoke',
    {
      preHandler: requireKeysWriteScope,
      schema: {
        params: RevokeSigningKeyParams,
        querystring: RevokeSigningKeyQuery,
        response: { 200: IssuerSigningKeyRevocationSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) =>
      controller.revoke(request.tenant, request.params.keyId, request.query.effective_at, reply),
  )
}
