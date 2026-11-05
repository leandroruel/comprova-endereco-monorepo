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
    // Sessão de usuário autenticada (Better Auth): já foi autenticada pelo
    // middleware de sessão. Não exigimos scopes de API key para sessões.
    if (request.sessionUser !== undefined) {
      return
    }

    const tenant = request.tenant
    if (tenant === undefined) {
      return reply.code(401).type(PROBLEM_CONTENT_TYPE).send(problems.unauthorized())
    }
    if (!tenant.scopes.includes(scope)) {
      return reply.code(403).type(PROBLEM_CONTENT_TYPE).send(problems.forbidden())
    }
  }

/**
 * Exige autenticação por sessão de usuário (dashboard) OU por credencial de
 * consumo (M2M com verify:m2m, ou chave user com scopes funcionais).
 *
 * Política de autenticação por endpoint:
 * - Sessão de usuário (cookie Better Auth): aceita em todos os endpoints de
 *   consumo e administração do dashboard.
 * - Chave API `m2m` via Bearer: aceita apenas se tiver o escopo `verify:m2m`
 *   (exclusivo de chaves M2M) e o scope funcional necessário para a operação.
 * - Chave API `user` via Bearer: aceita para endpoints de consumo se tiver
 *   `validate:read` ou `validate:write`. Não pode ter `verify:m2m` (esse
 *   escopo é exclusivo de chaves M2M).
 *
 * Isso garante que uma chave `user` não possa ser usada como credencial M2M
 * (não pode ter verify:m2m), mas ainda possa consumir endpoints de validação
 * quando possui os scopes funcionais adequados.
 */
export const requireSessionOrM2MVerify = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> => {
  // Sessão de usuário autenticada: contexto separado do dashboard, sempre
  // válido para endpoints de consumo.
  if (request.sessionUser !== undefined) {
    return
  }

  // Sem sessão: aceita credencial de consumo via Bearer.
  const tenant = request.tenant
  if (tenant === undefined) {
    return reply.code(401).type(PROBLEM_CONTENT_TYPE).send(problems.unauthorized())
  }

  // Chave M2M: exige verify:m2m (exclusivo de chaves M2M).
  if (tenant.keyType === 'm2m') {
    if (!tenant.scopes.includes(API_SCOPES.verifyM2m)) {
      return reply.code(403).type(PROBLEM_CONTENT_TYPE).send(problems.forbidden())
    }
    return
  }

  // Chave user: exige scope funcional de leitura ou escrita.
  if (tenant.keyType === 'user') {
    const hasRead = tenant.scopes.includes(API_SCOPES.validateRead)
    const hasWrite = tenant.scopes.includes(API_SCOPES.validateWrite)
    if (!hasRead && !hasWrite) {
      return reply.code(403).type(PROBLEM_CONTENT_TYPE).send(problems.forbidden())
    }
    return
  }

  // Tipo de chave desconhecido.
  return reply.code(403).type(PROBLEM_CONTENT_TYPE).send(problems.forbidden())
}

/**
 * Exige que a credencial autenticada seja de um `keyType` específico.
 *
 * - `user`: credencial de usuário autenticado (dashboard/sessão).
 * - `m2m`: credencial máquina-a-máquina (Bearer token, sem sessão de usuário).
 *
 * Deve rodar como `preHandler` de rotas montadas DEPOIS do `authenticate`.
 * Rotas de gerenciamento administrativo de API keys devem exigir `keyType =
 * 'user'` (via sessão); rotas de consumo M2M devem exigir `keyType = 'm2m'`.
 */
export const requireKeyType =
  (keyType: 'user' | 'm2m') =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const tenant = request.tenant
    if (tenant === undefined) {
      return reply.code(401).type(PROBLEM_CONTENT_TYPE).send(problems.unauthorized())
    }
    if (tenant.keyType !== keyType) {
      return reply.code(403).type(PROBLEM_CONTENT_TYPE).send(problems.forbidden())
    }
  }

export const requireReadScope = requireScope(API_SCOPES.validateRead)
export const requireWriteScope = requireScope(API_SCOPES.validateWrite)
export const requireKeysWriteScope = requireScope(API_SCOPES.keysWrite)
export const requireVerifyM2mScope = requireScope(API_SCOPES.verifyM2m)
