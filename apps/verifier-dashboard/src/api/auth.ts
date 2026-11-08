import { createAuthClient } from 'better-auth/react'

/**
 * Resolve a base URL do cliente de auth do dashboard verifier.
 *
 * Quando `VITE_DASHBOARD_VERIFIER_AUTH_URL` é apenas uma origem (ex.
 * `http://localhost:5174` ou `https://api.exemplo.com`), retorna apenas a
 * origem. O `basePath: '/api/auth'` do better-auth adiciona o caminho
 * correto (`/api/auth/sign-in/email`) para que o proxy do Vite capture
 * e encaminhe para a instância isolada do verifier (`/v1/auth/verifier/*`)
 * na porta 3000.
 *
 * Quando a URL já inclui `/v1/auth/verifier` (produção), é preservada
 * como está: o better-auth chama diretamente `/v1/auth/verifier/sign-in/email`
 * no servidor (sem proxy do Vite em produção).
 *
 * Sem a variável, usa string vazia e confia no proxy do Vite (dev).
 */
const resolveVerifierAuthBaseUrl = (): string => {
  const url = import.meta.env.VITE_DASHBOARD_VERIFIER_AUTH_URL ?? ''
  if (!url) return ''
  try {
    const parsed = new URL(url)
    const hasAuthPath = /^\/v1\/auth\/(admin|verifier)/.test(parsed.pathname)
    if (!hasAuthPath) {
      // Apenas uma origem: não adicionamos /v1/auth/verifier aqui. O
      // `basePath: '/api/auth'` do better-auth adiciona /api/auth à origem,
      // e o proxy do Vite captura /api/auth/* e reescreve para
      // /v1/auth/verifier/* no backend. Se adicionássemos /v1/auth/verifier
      // agora, o better-auth chamaria /v1/auth/verifier/sign-in/email
      // diretamente, que o proxy do Vite NÃO captura → 404.
      return parsed.origin
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
  // Quando `VITE_DASHBOARD_VERIFIER_AUTH_URL` não está definida (dev local),
  // `baseURL` fica vazio e o better-auth resolve para `window.location.origin`
  // sem path. O proxy do Vite só captura `/api/auth/*`, então forçamos o base
  // path para que as requisições de auth caiam em `/api/auth/sign-in/email`
  // e sejam encaminhadas para a instância do verifier na porta 3000.
  basePath: '/api/auth',
})

/** Identidade do usuário logado no Verifier Dashboard. */
export interface SessionUser {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly role: string
}
