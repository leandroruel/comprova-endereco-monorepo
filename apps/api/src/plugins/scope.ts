import { PROBLEM_CONTENT_TYPE, problems } from '@comprova/contracts'
import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * Scopes persistidos em `api_key.scopes` (migração `0002_tenancy.sql`).
 *
 * Esta é a definição central e única de scopes reconhecidos pelo backend.
 * Qualquer operação de autorização deve consultar esta lista; scopes que não
 * estiverem aqui são desconhecidos e devem ser rejeitados, independentemente
 * do que a interface do cliente envie.
 *
 * Não crie um scope novo para uma operação existente sem uma decisão de
 * contrato: a API key é emitida fora desta camada e o valor é assinado no
 * snapshot `validation.issuer_scopes`. O default continua sendo
 * `validate:read` + `validate:write`; `keys:write` é administrativo, opt-in e
 * não é concedido automaticamente a keys existentes (ADR-0030). `verify:m2m`
 * é exclusivo de chaves `key_type = 'm2m'` e permite consumir a API por Bearer
 * token sem sessão de usuário do dashboard (ADR-0030 / Fase 1 M2M).
 */
export const API_SCOPES = {
  validateRead: 'validate:read',
  validateWrite: 'validate:write',
  keysWrite: 'keys:write',
  verifyM2m: 'verify:m2m',
} as const

export type ApiScope = (typeof API_SCOPES)[keyof typeof API_SCOPES]

/** Todos os scopes reconhecidos pelo backend, para validação de entrada. */
export const ALL_API_SCOPES: readonly string[] = Object.values(API_SCOPES)

/**
 * Scopes permitidos por tipo de chave API.
 *
 * - `user`: credencial de usuário autenticado (dashboard/sessão). Não pode
 *   conter `verify:m2m` (operação exclusiva de M2M).
 * - `m2m`: credencial máquina-a-máquina, consumida por Bearer token sem
 *   sessão de usuário. Não pode conter `keys:write` (gerenciamento de chaves
 *   exige sessão de usuário autenticada).
 */
export const SCOPES_BY_KEY_TYPE: Record<'user' | 'm2m', readonly string[]> = {
  user: [API_SCOPES.validateRead, API_SCOPES.validateWrite, API_SCOPES.keysWrite],
  m2m: [API_SCOPES.validateRead, API_SCOPES.validateWrite, API_SCOPES.verifyM2m],
} as const

/**
 * Valida que todos os escopos são reconhecidos pelo backend. Lança `Error`
 * quando algum escopo é desconhecido.
 */
export const validateKnownScopes = (scopes: readonly string[]): void => {
  for (const scope of scopes) {
    if (!ALL_API_SCOPES.includes(scope)) {
      throw new Error(`unknown scope: ${scope}`)
    }
  }
}

/**
 * Valida que os escopos são reconhecidos e são permitidos para o `keyType`
 * informado. Lança `Error` quando houver escopo desconhecido ou não permitido
 * para aquele tipo de chave.
 */
export const validateScopesForKeyType = (keyType: 'user' | 'm2m', scopes: readonly string[]): void => {
  validateKnownScopes(scopes)
  const allowed = SCOPES_BY_KEY_TYPE[keyType]
  for (const scope of scopes) {
    if (!allowed.includes(scope)) {
      throw new Error(`scope '${scope}' not allowed for key type '${keyType}'`)
    }
  }
}

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
export const requireKeysWriteScope = requireScope(API_SCOPES.keysWrite)
export const requireVerifyM2mScope = requireScope(API_SCOPES.verifyM2m)
