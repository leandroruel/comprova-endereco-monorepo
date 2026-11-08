import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_DASHBOARD_ADMIN_AUTH_URL ?? '',
})

/** Identidade que o sidemenu exibe; nula enquanto a sessão não resolveu. */
export interface SessionUser {
  readonly name?: string | null
  readonly email?: string | null
  readonly role?: string | null
}
