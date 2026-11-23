import type { FastifyRequest, FastifyReply } from 'fastify'

/**
 * Instância de auth que emitiu a sessão. `admin` e `verifier` são espaços de
 * identidade distintos (`admin_user` vs `verifier_user`): só ids de `verifier`
 * podem ser gravados nas colunas com FK para `verifier_user` (ex.:
 * `validation.user_id`, `batch.user_id`, `organization_member.user_id`).
 */
export type SessionSource = 'admin' | 'verifier'

export interface SessionUser {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly role: string
  readonly source: SessionSource
}

/** Forma mínima necessária pelas instâncias de auth neste middleware. */
export interface AuthInstance {
  api: {
    getSession: (opts: { headers: Headers }) => Promise<{
      user: {
        readonly id: string
        readonly email: string
        readonly name: string
        readonly role?: string | null
      } | null
    } | null>
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    sessionUser?: SessionUser
  }
}

/**
 * Origens dos dashboards, espelham `trustedOrigins` das instâncias de auth e
 * a lista `allowedOrigins` do CORS.
 *
 * O browser envia TODOS os cookies de um host para qualquer porta dele
 * (cookies não são isolados por porta). Em localhost, o cookie
 * `admin-auth.session_token` chega junto ao backend também nas requests do
 * dashboard do verifier — e vice-versa. Sem uma regra de seleção por origem,
 * um login no dashboard admin apareceria como sessão no verifier.
 */
export interface SessionMiddlewareAuths {
  readonly admin: AuthInstance
  readonly verifier: AuthInstance
  readonly adminOrigins: readonly string[]
  readonly verifierOrigins: readonly string[]
}

/**
 * Origem do contexto do dashboard que originou a request.
 *
 * Browser: `Origin` (POST e fetch cross-origin) ou, nas GETs same-origin em
 * que o `Origin` não é enviado, `Referer`. Backends/scripts sem nenhum dos
 * dois retornam undefined e seguem o fallback completo.
 */
const requestOrigin = (request: FastifyRequest): string | undefined => {
  const origin = request.headers.origin
  if (typeof origin === 'string' && origin.length > 0) return origin
  const referer = request.headers.referer
  if (typeof referer === 'string' && referer.length > 0) {
    try {
      return new URL(referer).origin
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Id do usuário do Verifier (`verifier_user.id`) associado à sessão.
 *
 * Retorna `null` para sessões do dashboard administrativo. O dashboard admin
 * envia, na mesma request, o Bearer de uma API key e o cookie da sessão
 * `admin_user`; gravar `admin_user.id` em colunas com FK para `verifier_user`
 * (ex.: `validation.user_id`) viola a constraint e derruba a request com 500.
 * O `user_id` dessas colunas deve refletir apenas a identidade do Verifier.
 */
export const verifierUserId = (request: FastifyRequest): string | null =>
  request.sessionUser?.source === 'verifier' ? request.sessionUser.id : null

/**
 * Middleware de sessão do dashboard (Better Auth).
 *
 * Popula `request.sessionUser` a partir do cookie de sessão da instância de
 * auth correspondente ao dashboard que fez a request:
 * - origin do verifier   → somente a instância verifier;
 * - origin do admin      → somente a instância admin;
 * - sem origem conhecida → nenhuma sessão é resolvida (sem fallback).
 *
 * A sessão é opcional: rotas que a exigem usam `requireSessionUser` (ou
 * `requireOrganizationAccess`) e retornam 401 quando não há sessão.
 *
 * Não reusa o token de sessão como credencial de API: é um contexto de
 * autenticação distinto do `authenticate` (chaves de API/Bearer).
 */
export const makeSessionMiddleware = (auths: SessionMiddlewareAuths) => {
  const verifierOrigins = new Set(auths.verifierOrigins)
  const adminOrigins = new Set(auths.adminOrigins)

  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    try {
      const cookieHeader = request.headers.cookie
      if (cookieHeader === undefined) return

      const origin = requestOrigin(request)
      const candidates: readonly { readonly auth: AuthInstance; readonly source: SessionSource }[] =
        origin !== undefined && verifierOrigins.has(origin)
          ? [{ auth: auths.verifier, source: 'verifier' }]
          : origin !== undefined && adminOrigins.has(origin)
            ? [{ auth: auths.admin, source: 'admin' }]
            : []

      const headers = new Headers()
      headers.set('cookie', cookieHeader)

      for (const { auth, source } of candidates) {
        const session = await auth.api.getSession({ headers })
        if (session?.user) {
          // O plugin admin do better-auth inclui o campo `role` no usuário.
          const user = session.user as { readonly role?: string | null }
          request.sessionUser = {
            id: session.user.id,
            email: session.user.email,
            name: session.user.name,
            role: user.role ?? 'user',
            source,
          }
          return
        }
      }
    } catch {
      // silently ignore — session is optional
    }
  }
}
