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
 * Middleware de sessão do dashboard (Better Auth).
 *
 * Popula `request.sessionUser` a partir do cookie de sessão de qualquer uma
 * das instâncias de auth fornecidas (legacy, admin e verifier), garantindo
 * isolamento de sessão entre os dashboards. A sessão é opcional: rotas que a
 * exigem usam `requireSessionUser` (ou `requireOrganizationAccess`) e
 * retornam 401 quando não há sessão.
 *
 * Não reusa o token de sessão como credencial de API: é um contexto de
 * autenticação distinto do `authenticate` (chaves de API/Bearer).
 */
export const makeSessionMiddleware = (...auths: AuthInstance[]) => {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    try {
      const cookieHeader = request.headers.cookie
      if (cookieHeader === undefined) return

      const headers = new Headers()
      headers.set('cookie', cookieHeader)

      for (const auth of auths) {
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
