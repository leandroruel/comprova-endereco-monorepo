import { createAuthClient } from 'better-auth/react'

/**
 * Resolve a base URL do cliente de auth do dashboard admin.
 *
 * Quando `VITE_DASHBOARD_ADMIN_AUTH_URL` é apenas uma origem (ex.
 * `http://localhost:5173` ou `https://api.exemplo.com`), retorna apenas a
 * origem. O `basePath: '/api/auth'` do better-auth adiciona o caminho
 * correto (`/api/auth/sign-in/email`) para que o proxy do Vite capture
 * e encaminhe para a instância isolada do admin (`/v1/auth/admin/*`)
 * na porta 3000.
 *
 * Quando a URL já inclui `/v1/auth/admin` (produção), é preservada
 * como está: o better-auth chama diretamente `/v1/auth/admin/sign-in/email`
 * no servidor (sem proxy do Vite em produção).
 *
 * Sem a variável, usa string vazia e confia no proxy do Vite (dev).
 */
const resolveAdminAuthBaseUrl = (): string => {
  const url = import.meta.env.VITE_DASHBOARD_ADMIN_AUTH_URL ?? ''
  if (!url) return ''
  try {
    const parsed = new URL(url)
    const hasAuthPath = /^\/v1\/auth\/(admin|verifier)/.test(parsed.pathname)
    if (!hasAuthPath) {
      // Apenas uma origem: não adicionamos /v1/auth/admin aqui. O
      // `basePath: '/api/auth'` do better-auth adiciona /api/auth à origem,
      // e o proxy do Vite captura /api/auth/* e reescreve para
      // /v1/auth/admin/* no backend. Se adicionássemos /v1/auth/admin
      // agora, o better-auth chamaria /v1/auth/admin/sign-in/email
      // diretamente, que o proxy do Vite NÃO captura → 404.
      return parsed.origin
    }
    return parsed.toString()
  } catch {
    return url
  }
}

export const authClient = createAuthClient({
  baseURL: resolveAdminAuthBaseUrl(),
  // Quando `VITE_DASHBOARD_ADMIN_AUTH_URL` não está definida (dev local),
  // `baseURL` fica vazio e o better-auth resolve para `window.location.origin`
  // sem path. O proxy do Vite só captura `/api/auth/*`, então forçamos o base
  // path para que as requisições de auth caiam em `/api/auth/sign-in/email`
  // e sejam encaminhadas para a instância do admin na porta 3000.
  basePath: '/api/auth',
  // O `formCsrfMiddleware` do better-auth valida o cabeçalho `Origin` em
  // requisições POST de auth quando há `Sec-Fetch-*` headers (navegador).
  // O navegador não envia `Origin` em `fetch` same-origin com
  // `credentials: 'include'`, então forçamos o header para evitar 403 CSRF.
  fetchOptions: {
    onRequest: (context) => {
      if (typeof window !== 'undefined' && window.location) {
        context.headers.set('origin', window.location.origin);
      }
    },
  },
})

/** Identidade que o sidemenu exibe; nula enquanto a sessão não resolveu. */
export interface SessionUser {
  readonly name?: string | null
  readonly email?: string | null
  readonly role?: string | null
}
