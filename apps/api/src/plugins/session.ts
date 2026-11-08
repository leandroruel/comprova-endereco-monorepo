import type { FastifyRequest, FastifyReply } from 'fastify'

export interface SessionUser {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly role: string
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
const VERIFIER_ORIGINS = new Set(['http://localhost:5174', 'http://verifier.localhost:5174'])
const ADMIN_ORIGINS = new Set(['http://localhost:5173', 'http://admin.localhost:5173'])

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
 * Middleware de sessão do dashboard (Better Auth).
 *
 * Popula `request.sessionUser` a partir do cookie de sessão da instância de
 * auth correspondente ao dashboard que fez a request:
 * - origin do verifier   → somente a instância verifier;
 * - origin do admin      → somente a instância admin;
 * - sem origem conhecida → legacy, admin e verifier (ordem legada, para
 *   curl/testes/scripts server-to-server).
 *
 * A sessão é opcional: rotas que a exigem usam `requireSessionUser` (ou
 * `requireOrganizationAccess`) e retornam 401 quando não há sessão.
 *
 * Não reusa o token de sessão como credencial de API: é um contexto de
 * autenticação distinto do `authenticate` (chaves de API/Bearer).
 */
export interface SessionMiddlewareAuths {
  readonly legacy: AuthInstance
  readonly admin: AuthInstance
  readonly verifier: AuthInstance
}

export const makeSessionMiddleware = (auths: SessionMiddlewareAuths) => {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    try {
      const cookieHeader = request.headers.cookie
      if (cookieHeader === undefined) return

      const origin = requestOrigin(request)
      const candidates: AuthInstance[] =
        origin !== undefined && VERIFIER_ORIGINS.has(origin)
          ? [auths.verifier]
          : origin !== undefined && ADMIN_ORIGINS.has(origin)
            ? [auths.admin]
            : [auths.legacy, auths.admin, auths.verifier]

      const headers = new Headers()
      headers.set('cookie', cookieHeader)

      for (const auth of candidates) {
        const session = await auth.api.getSession({ headers })
        if (session?.user) {
          // O plugin admin do better-auth inclui o campo `role` no usuário.
          const user = session.user as { readonly role?: string | null }
          request.sessionUser = {
            id: session.user.id,
            email: session.user.email,
            name: session.user.name,
            role: user.role ?? 'user',
          }
          return
        }
      }
    } catch {
      // silently ignore — session is optional
    }
  }
}
