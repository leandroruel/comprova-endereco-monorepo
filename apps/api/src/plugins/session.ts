import type { FastifyRequest, FastifyReply } from 'fastify'
import type { Auth } from '../auth.js'

export interface SessionUser {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly role: string
}

declare module 'fastify' {
  interface FastifyRequest {
    sessionUser?: SessionUser
  }
}

export const makeSessionMiddleware = (auth: Auth) => {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    try {
      const cookieHeader = request.headers.cookie
      if (cookieHeader === undefined) return

      const url = `http://localhost/api/auth/get-session`
      const headers = new Headers()
      headers.set('cookie', cookieHeader)
      const incoming = new Request(url, { method: 'GET', headers })

      const session = await auth.api.getSession({ headers: incoming })
      if (session?.user) {
        // O plugin admin do better-auth inclui o campo `role` no objeto do usuário.
        const user = session.user as { readonly role?: string | null }
        request.sessionUser = {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name,
          role: user.role ?? 'user',
        }
      }
    } catch {
      // silently ignore — session is optional
    }
  }
}
