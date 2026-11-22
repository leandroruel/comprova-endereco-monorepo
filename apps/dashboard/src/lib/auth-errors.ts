import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy'

/**
 * Mensagem amigável para os códigos de erro que o Better Auth devolve em
 * `POST /change-password` (via proxy do Worker para `/v1/auth/admin/*`).
 */
export const describeAuthError = (code: string | undefined, fallback?: string): string => {
  switch (code) {
    case 'INVALID_PASSWORD':
      return 'Senha atual incorreta.'
    case 'PASSWORD_TOO_SHORT':
      return `A nova senha deve ter no mínimo ${PASSWORD_MIN_LENGTH} caracteres.`
    case 'PASSWORD_TOO_LONG':
      return 'A nova senha é longa demais.'
    case 'CREDENTIAL_ACCOUNT_NOT_FOUND':
      return 'Esta conta não possui credencial de senha. Solicite acesso ao administrador.'
    default:
      return fallback ?? 'Não foi possível alterar a senha. Tente novamente.'
  }
}
