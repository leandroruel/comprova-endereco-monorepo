import { createAuthClient } from 'better-auth/react'

/**
 * Resolve a base URL do cliente de auth do dashboard admin.
 *
 * Quando `VITE_DASHBOARD_ADMIN_AUTH_URL` é apenas uma origem (ex.
 * `https://api.exemplo.com`), adiciona o caminho da instância isolada
 * (`/v1/auth/admin`) para que requisições de auth não caiam no endpoint
 * legacy `/api/auth`. Quando a URL já inclui o caminho, é preservada.
 * Sem a variável, usa string vazia e confia no proxy do Vite (dev).
 */
const resolveAdminAuthBaseUrl = (): string => {
  const url = import.meta.env.VITE_DASHBOARD_ADMIN_AUTH_URL ?? ''
  if (!url) return ''
  try {
    const parsed = new URL(url)
    const hasAuthPath = /^\/v1\/auth\/(admin|verifier)/.test(parsed.pathname)
    if (!hasAuthPath) {
      parsed.pathname =
        (parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname) + '/v1/auth/admin'
    }
    return parsed.toString()
  } catch {
    return url
  }
}

export const authClient = createAuthClient({
  baseURL: resolveAdminAuthBaseUrl(),
})

/** Identidade que o sidemenu exibe; nula enquanto a sessão não resolveu. */
export interface SessionUser {
  readonly name?: string | null
  readonly email?: string | null
  readonly role?: string | null
}
