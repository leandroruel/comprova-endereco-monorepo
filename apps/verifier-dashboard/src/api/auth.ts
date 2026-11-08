import { createAuthClient } from 'better-auth/react'

/**
 * Cliente de autenticação Better Auth apontando para a API do Comprova
 * (mesma instância usada pelo dashboard administrativo). O contexto de
 * autorização é o de usuários do Verifier Dashboard (sessão por cookie),
 * distinto do contexto administrativo.
 */
export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_DASHBOARD_VERIFIER_AUTH_URL ?? '',
})

/** Identidade do usuário logado no Verifier Dashboard. */
export interface SessionUser {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly role: string
}
