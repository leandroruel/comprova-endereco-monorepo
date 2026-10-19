import {
  CredentialStatusDocumentSchema,
  IssuerKeyDocumentSchema,
  WELL_KNOWN_ISSUER_PATH,
} from '@comprova/credential'
import { PROBLEM_CONTENT_TYPE, ProblemSchema, problems } from '@comprova/contracts'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { IssuerControllerDeps } from './issuers.controller.js'
import { makeIssuerController } from './issuers.controller.js'

export type IssuerRoutesDeps = IssuerControllerDeps

/**
 * `scope` é o digest do tenant na URL do issuer (`issuerScopeOf`, 43 chars
 * base64url). O formato é validado aqui para não servir documento em path
 * arbitrário.
 */
const IssuerScopeParams = z.object({ scope: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })

/**
 * Params do status público: o mesmo escopo do issuer e o `credential_id`
 * opaco (43 chars base64url) que aparece em `credentialStatus.id`.
 */
const CredentialStatusParams = z.object({
  scope: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  credentialId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})

export const registerIssuerRoutes = (instance: FastifyInstance, deps: IssuerRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeIssuerController(deps)

  // O mesmo documento é servido em dois caminhos: `/issuers/:scope` é a
  // localização canônica e `/.well-known/comprova-issuer/:scope` é a porta de
  // descoberta (RFC 8615). Registrar as duas rotas com o mesmo handler evita
  // duplicar consulta, isolamento por escopo e serialização.
  const registerKeyDocumentRoute = (path: string): void => {
    app.get(
      path,
      {
        schema: {
          params: IssuerScopeParams,
          response: { 200: IssuerKeyDocumentSchema, 404: ProblemSchema },
        },
      },
      async (request, reply) => {
        const document = await controller.keyDocument(request.params.scope)
        if (document === null) {
          return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound('issuer'))
        }
        return reply.send(document)
      },
    )
  }

  registerKeyDocumentRoute('/issuers/:scope')
  registerKeyDocumentRoute(`/${WELL_KNOWN_ISSUER_PATH}/:scope`)

  // Status público da credencial: a URL assinada em `credentialStatus.id` é
  // `<issuer.id>/credentials/<credentialId>/status`, servida aqui fora do
  // `/v1` (sem API key). Só ACTIVE/REVOKED; 404 para credencial desconhecida.
  app.get(
    '/issuers/:scope/credentials/:credentialId/status',
    {
      schema: {
        params: CredentialStatusParams,
        response: { 200: CredentialStatusDocumentSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const document = await controller.credentialStatus(request.params.scope, request.params.credentialId)
      if (document === null) {
        return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound('credential'))
      }
      return reply.send(document)
    },
  )
}
