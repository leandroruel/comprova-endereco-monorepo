import { createAuthClient } from 'better-auth/react'

/**
 * Resolve a base URL do cliente de auth do dashboard admin.
 *
 * Em produção (Cloudflare Pages), forçamos baseURL vazio para que as
 * requisições de auth caiam no mesmo domínio (/api/auth/...) e sejam
 * interceptadas pelo Worker proxy.
 *
 * Em desenvolvimento (localhost), usamos a URL configurada ou vazio para
 * o proxy do Vite.
 */
const resolveAdminAuthBaseUrl = (): string => {
  const url = import.meta.env.VITE_DASHBOARD_ADMIN_AUTH_URL ?? ''
  if (!url) return ''
  // Em produção (não localhost), não usamos a URL configurada: as requisições
  // de auth devem cair no mesmo domínio para serem interceptadas pelo Worker.
  if (!url.includes('localhost')) {
    return ''
  }
  try {
    const parsed = new URL(url)
    const hasAuthPath = /^\/v1\/auth\/(admin|verifier)/.test(parsed.pathname)
    if (!hasAuthPath) {
      return parsed.origin
    }
    return parsed.toString()
  } catch {
    return url
  }
}

export const authClient = createAuthClient({
  baseURL: resolveAdminAuthBaseUrl(),
  // Requisições de auth caem em /api/auth/sign-in/email na mesma origem e
  // são interceptadas pelo Worker proxy (ou pelo proxy do Vite em dev).
  basePath: '/api/auth',
})

/** Identidade que o sidemenu exibe; nula enquanto a sessão não resolveu. */
export interface SessionUser {
  readonly name?: string | null
  readonly email?: string | null
  readonly role?: string | null
}
