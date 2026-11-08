import { createAuthClient } from 'better-auth/react'

/**
 * Resolve a base URL do cliente de auth do dashboard verifier.
 *
 * Quando `VITE_DASHBOARD_VERIFIER_AUTH_URL` é apenas uma origem (ex.
 * `https://api.exemplo.com`), adiciona o caminho da instância isolada
 * (`/v1/auth/verifier`) para que requisições de auth não caiam no endpoint
 * legacy `/api/auth`. Quando a URL já inclui o caminho, é preservada.
 * Sem a variável, usa string vazia e confia no proxy do Vite (dev).
 */
const resolveVerifierAuthBaseUrl = (): string => {
  const url = import.meta.env.VITE_DASHBOARD_VERIFIER_AUTH_URL ?? ''
  if (!url) return ''
  try {
    const parsed = new URL(url)
    const hasAuthPath = /^\/v1\/auth\/(admin|verifier)/.test(parsed.pathname)
    if (!hasAuthPath) {
      parsed.pathname =
        (parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname) + '/v1/auth/verifier'
    }
    return parsed.toString()
  } catch {
    return url
  }
}

/**
 * Cliente de autenticação Better Auth apontando para a instância isolada do
 * dashboard verifier. O contexto de autorização é o de usuários do Verifier
 * Dashboard (sessão por cookie), distinto do contexto administrativo.
 */
export const authClient = createAuthClient({
  baseURL: resolveVerifierAuthBaseUrl(),
})

/** Identidade do usuário logado no Verifier Dashboard. */
export interface SessionUser {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly role: string
}
