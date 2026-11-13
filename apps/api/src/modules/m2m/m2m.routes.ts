import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { Db } from '@comprova/db'
import { ProblemSchema } from '@comprova/contracts'
import { makeM2MController } from './m2m.controller.js'
import { ApiKeyIdParams, ApiKeyCreatedResponse, ApiKeyDtoSchema } from './m2m.schema.js'
import { requireSessionOrM2MVerify, requireKeyType } from '../../plugins/scope.js'

export type M2MRoutesDeps = {
  readonly db: Db
  readonly apiKeyPepper: string
}

/**
 * Resolve o tenantId a partir do body ou da query string, aceitando ambos.
 *
 * Regras:
 *  - Somente body: aceita.
 *  - Somente query: aceita.
 *  - Ambos com UUID equivalente: aceita (normaliza caixa).
 *  - Ambos com UUID divergente: 400.
 *  - Nenhum dos dois: 400.
 *  - UUID inválido: 400.
 *
 * O tenantId informado pelo cliente nunca é prova de autorização: a validação
 * de membership e de papel continua sendo feita pelos middlewares e serviço
 * subsequentes, que usam o contexto de tenant autenticado.
 */
const resolveTenantId = (
  request: FastifyRequest,
  reply: FastifyReply,
): { readonly tenantId: string } | { readonly error: FastifyReply } => {
  const body = request.body as { readonly tenantId?: string } | undefined
  const query = request.query as { readonly tenantId?: string } | undefined

  const bodyTenantId = body?.tenantId
  const queryTenantId = query?.tenantId

  if (!bodyTenantId && !queryTenantId) {
    return {
      error: reply
        .code(400)
        .type('application/problem+json')
        .send(
          ProblemSchema.parse({
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            code: 'MISSING_TENANT_ID',
            detail: 'tenantId é obrigatório no body ou na query string',
          }),
        ),
    }
  }

  if (bodyTenantId && queryTenantId && bodyTenantId.toLowerCase() !== queryTenantId.toLowerCase()) {
    return {
      error: reply
        .code(400)
        .type('application/problem+json')
        .send(
          ProblemSchema.parse({
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            code: 'INVALID_TENANT_ID',
            detail: 'tenantId no body e na query string são diferentes',
          }),
        ),
    }
  }

  const tenantId = (bodyTenantId ?? queryTenantId!).toLowerCase()

  if (!z.string().uuid().safeParse(tenantId).success) {
    return {
      error: reply
        .code(400)
        .type('application/problem+json')
        .send(
          ProblemSchema.parse({
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            code: 'INVALID_TENANT_ID',
            detail: 'tenantId inválido',
          }),
        ),
    }
  }

  return { tenantId }
}

/**
 * PreHandler que resolve o tenantId de body/query e o espelha em
 * `request.query.tenantId` para que o `requireSessionOrM2MVerify` (que lê a
 * query string) possa estabelecer o contexto de tenant autenticado mesmo
 * quando o cliente envia o tenantId apenas no body.
 */
const resolveTenantPreHandler =
  () =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const result = (await Promise.resolve(resolveTenantId(request, reply))) as {
      error?: FastifyReply
      tenantId?: string
    }
    if ('error' in result) {
      return result.error
    }
    // Espelha para a query para downstream (requireSessionOrM2MVerify lê query.tenantId).
    if (
      request.query &&
      typeof request.query === 'object' &&
      !(request.query as { tenantId?: string }).tenantId
    ) {
      ;(request.query as { tenantId?: string }).tenantId = result.tenantId
    }
    return undefined
  }

/**
 * Exige sessão de usuário autenticada (Better Auth).
 * Chaves API via Bearer (mesmo do tipo 'user') não podem administrar
 * outras API keys: essa operação é exclusiva de sessão de dashboard.
 */
const requireUserSession = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> => {
  if (request.sessionUser === undefined) {
    return (await Promise.resolve(
      reply
        .code(401)
        .type('application/problem+json')
        .send({ type: 'about:blank', title: 'Unauthorized', status: 401, code: 'USER_SESSION_REQUIRED' }),
    )) as FastifyReply
  }
  return undefined
}

export const registerM2MRoutes = (instance: FastifyInstance, deps: M2MRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeM2MController(deps)

  // Rotas de gestão de API keys: exigem sessão de usuário autenticada (não
  // aceita credencial Bearer como substituta), chave do tipo 'user' e scope
  // keys:write. O tenant pode vir no body ou na query string.
  app.post(
    '/m2m/api-keys',
    {
      preHandler: [
        resolveTenantPreHandler(),
        requireSessionOrM2MVerify(deps.db),
        requireUserSession,
        requireKeyType('user'),
      ],
      schema: {
        querystring: z.object({ tenantId: z.string().uuid().optional() }),
        body: z.object({
          tenantId: z.string().uuid().optional(),
          name: z.string().min(1).max(100),
          scopes: z.array(z.string()).default(['validate:read', 'validate:write']),
          keyType: z.enum(['user', 'm2m']).default('m2m'),
          expiresInDays: z.number().int().min(1).max(3650).optional(),
        }),
        response: { 201: ApiKeyCreatedResponse },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenant?.tenantId ?? ''
      return controller.create(
        {
          tenantId,
          name: request.body.name,
          scopes: request.body.scopes,
          keyType: request.body.keyType,
          expiresInDays: request.body.expiresInDays,
          userId: request.sessionUser!.id,
        },
        reply,
      )
    },
  )

  app.get(
    '/m2m/api-keys',
    {
      preHandler: [requireSessionOrM2MVerify(deps.db), requireUserSession, requireKeyType('user')],
      schema: {
        querystring: z.object({ tenantId: z.string().uuid() }),
        response: { 200: ApiKeyDtoSchema },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenant?.tenantId ?? ''
      return controller.list(tenantId, request.sessionUser!.id, reply)
    },
  )

  app.delete(
    '/m2m/api-keys/:apiKeyId',
    {
      preHandler: [
        resolveTenantPreHandler(),
        requireSessionOrM2MVerify(deps.db),
        requireUserSession,
        requireKeyType('user'),
      ],
      schema: {
        params: ApiKeyIdParams,
        querystring: z.object({ tenantId: z.string().uuid().optional() }),
        body: z.object({ tenantId: z.string().uuid().optional() }).nullable().optional().default({}),
        response: {
          200: z.object({ revoked: z.boolean() }),
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenant?.tenantId ?? ''
      return controller.revoke(tenantId, request.params.apiKeyId, request.sessionUser!.id, reply)
    },
  )
}
