import { useState } from 'react'
import { RiInformationLine, RiLockLine, RiLockPasswordLine, RiShieldKeyholeLine } from '@remixicon/react'
import { authClient } from '@/api/auth'
import { Button } from '@/components/base/buttons/button'
import { Input } from '@/components/base/input/input'
import { SpinnerGlyph } from '@/components/base/spinner/spinner'
import { PasswordStrength } from '@/components/password-strength'
import { describeAuthError } from '@/lib/auth-errors'
import { PASSWORD_MIN_LENGTH, isPasswordValid } from '@/lib/password-policy'

/**
 * Alteração de senha do painel, sem área de configurações: um formulário
 * único que chama o endpoint nativo do Better Auth. Com
 * `revokeOtherSessions: true`, as demais sessões do usuário são encerradas e
 * a sessão atual é renovada (a API reemite o cookie), então o painel continua
 * autenticado neste dispositivo.
 */
export default function ChangePasswordPage() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  const passwordsDontMatch = confirmPassword.length > 0 && confirmPassword !== newPassword

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setSuccess(false)

    if (!isPasswordValid(newPassword)) {
      setError('A nova senha não atende aos requisitos mínimos.')
      return
    }
    if (newPassword === currentPassword) {
      setError('A nova senha deve ser diferente da atual.')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('As senhas não coincidem.')
      return
    }

    setLoading(true)
    try {
      const result = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      })
      if (result.error) {
        setError(describeAuthError(result.error.code, result.error.message))
        return
      }
      setSuccess(true)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch {
      setError('Não foi possível alterar a senha. Verifique sua conexão e tente novamente.')
    } finally {
      setLoading(false)
    }
  }

  const canSubmit =
    currentPassword.length > 0 && isPasswordValid(newPassword) && confirmPassword === newPassword && !loading
  const isPristine = currentPassword.length === 0 && newPassword.length === 0 && confirmPassword.length === 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-title-3-semibold text-text-primary">Alterar senha</h1>
        <p className="text-body-regular text-text-secondary">
          Redefina a senha da sua conta. Outras sessões conectadas serão encerradas.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <form
          onSubmit={(event) => {
            void handleSubmit(event)
          }}
          noValidate
          className="flex flex-col gap-5 rounded-3xl border border-border-button-default bg-background-primary-default p-6 lg:col-span-2"
        >
          <Input
            label="Senha atual"
            type="password"
            placeholder="••••••••"
            autoComplete="current-password"
            value={currentPassword}
            onChange={setCurrentPassword}
            leadingIcon={RiLockLine}
            isDisabled={loading}
            inputDir="ltr"
          />

          <div className="flex flex-col gap-2">
            <Input
              label="Nova senha"
              type="password"
              placeholder="••••••••"
              autoComplete="new-password"
              value={newPassword}
              onChange={setNewPassword}
              leadingIcon={RiLockPasswordLine}
              isDisabled={loading}
              inputDir="ltr"
              hint={`Mínimo de ${PASSWORD_MIN_LENGTH} caracteres com maiúscula, minúscula, número e símbolo.`}
            />
            <PasswordStrength password={newPassword} />
          </div>

          <Input
            label="Confirmar nova senha"
            type="password"
            placeholder="••••••••"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            leadingIcon={RiLockPasswordLine}
            isDisabled={loading}
            isInvalid={passwordsDontMatch}
            errorMessage={passwordsDontMatch ? 'As senhas não coincidem.' : undefined}
            inputDir="ltr"
          />

          {error && (
            <p
              role="alert"
              className="rounded-xl bg-notification-error-background px-3 py-2 text-body-regular text-notification-error-foreground"
            >
              {error}
            </p>
          )}
          {success && (
            <p
              role="status"
              className="rounded-xl bg-notification-success-background px-3 py-2 text-body-regular text-state-success-text"
            >
              Senha alterada. As outras sessões foram encerradas e este dispositivo permanece conectado.
            </p>
          )}

          <div className="flex items-center justify-end gap-3">
            <Button
              variant="secondary"
              type="button"
              disabled={loading || isPristine}
              onClick={() => {
                setCurrentPassword('')
                setNewPassword('')
                setConfirmPassword('')
                setError(null)
              }}
            >
              Limpar
            </Button>
            <Button variant="primary" type="submit" disabled={!canSubmit} leadingIcon={RiShieldKeyholeLine}>
              {loading ? (
                <>
                  <SpinnerGlyph size="sm" className="text-white" />
                  <span>Salvando…</span>
                </>
              ) : (
                'Alterar senha'
              )}
            </Button>
          </div>
        </form>

        <aside className="flex h-max flex-col gap-3 rounded-3xl border border-border-button-default bg-background-primary-default p-6">
          <span className="flex items-center gap-2 text-body-medium text-text-primary">
            <RiInformationLine className="size-5 text-foreground-icon-secondary" aria-hidden />
            Boas práticas
          </span>
          <ul className="flex list-disc flex-col gap-1.5 ps-4 text-body-regular text-text-secondary">
            <li>Use uma senha única, que você não usa em outros serviços.</li>
            <li>Prefira uma frase-longa com símbolos a uma senha curta complexa.</li>
            <li>Ao trocar a senha, todas as outras sessões são desconectadas automaticamente.</li>
          </ul>
        </aside>
      </div>
    </div>
  )
}
