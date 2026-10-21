import { PROBLEM_CONTENT_TYPE, problems } from '@comprova/contracts'
import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * Scopes persistidos em `api_key.scopes` (migração `0002_tenancy.sql`).
 *
 * Não crie um scope novo para uma operação existente sem uma decisão de
 * contrato: a API key é emitida fora desta camada e o valor é assinado no
 * snapshot `validation.issuer_scopes`. Enquanto só existirem estes dois,
 * leitura = `validate:read` e qualquer mutação = `validate:write`.
 */
export const API_SCOPES = {
  validateRead: 'validate:read',
  validateWrite: 'validate:write',
} as const

export type ApiScope = (typeof API_SCOPES)[keyof typeof API_SCOPES]

/**
 * Guard de autorização por scope. Deve rodar como `preHandler` de uma rota
 * montada DEPOIS do `authenticate` (que preenche `request.tenant`).
 *
 * - sem tenant → 401 (rota montada fora do authenticate ou autenticação falhou);
 * - tenant sem o scope → 403 `FORBIDDEN` ("Insufficient scope").
 *
 * O 403 é decidido antes do handler e não consulta o recurso: um `key_id` ou
 * `credential_id` de outro tenant não vira oráculo de existência. O isolamento
 * por tenant continua sendo feito pelo RLS/`withTenant` no serviço.
 */
export const requireScope =
  (scope: ApiScope) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const tenant = request.tenant
    if (tenant === undefined) {
      return reply.code(401).type(PROBLEM_CONTENT_TYPE).send(problems.unauthorized())
    }
    if (!tenant.scopes.includes(scope)) {
      return reply.code(403).type(PROBLEM_CONTENT_TYPE).send(problems.forbidden())
    }
  }

export const requireReadScope = requireScope(API_SCOPES.validateRead)
export const requireWriteScope = requireScope(API_SCOPES.validateWrite)
