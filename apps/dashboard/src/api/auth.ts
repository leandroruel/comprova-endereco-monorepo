import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient({
  baseURL: 'http://localhost:3000',
})

/** Identidade que o sidemenu exibe; nula enquanto a sessão não resolveu. */
export interface SessionUser {
  readonly name?: string | null
  readonly email?: string | null
  readonly role?: string | null
}
