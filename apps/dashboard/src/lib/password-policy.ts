/**
 * Política de senha exibida na UI (login e troca de senha).
 *
 * O backend (Better Auth) garante o mínimo de 8 caracteres; os demais itens
 * são uma exigência de UX para que a senha do painel administrativo tenha
 * entropia mínima antes mesmo de chegar à API.
 */
export const PASSWORD_MIN_LENGTH = 8

export interface PasswordCheck {
  readonly label: string
  readonly passed: boolean
}

export const checkPassword = (password: string): readonly PasswordCheck[] => [
  { label: `Mínimo ${PASSWORD_MIN_LENGTH} caracteres`, passed: password.length >= PASSWORD_MIN_LENGTH },
  { label: 'Uma letra maiúscula', passed: /[A-Z]/.test(password) },
  { label: 'Uma letra minúscula', passed: /[a-z]/.test(password) },
  { label: 'Um número', passed: /\d/.test(password) },
  { label: 'Um caractere especial', passed: /[!@#$%^&*()_+\-=[\]{}|;:,.<>?]/.test(password) },
]

export const isPasswordValid = (password: string): boolean =>
  checkPassword(password).every((check) => check.passed)
