import { useMemo } from 'react'
import { RiCheckboxCircleFill, RiCloseCircleFill } from '@remixicon/react'
import { checkPassword } from '@/lib/password-policy'
import { cx } from '@/utils/cx'

/**
 * Medidor + checklist da política de senha, usado no login e na troca de
 * senha. Cores de feedback usam os tokens de notificação do tema (sem
 * paleta crua), então funcionam em claro e escuro.
 */
export function PasswordStrength({ password }: { password: string }) {
  const checks = useMemo(() => checkPassword(password), [password])
  const score = checks.filter((check) => check.passed).length
  const strength = score === 0 ? 0 : score <= 2 ? 1 : score <= 4 ? 2 : 5

  const barColor =
    strength === 0
      ? 'bg-background-tertiary-default'
      : strength === 1
        ? 'bg-notification-error-foreground'
        : strength === 2
          ? 'bg-notification-information-foreground'
          : 'bg-notification-success-foreground'
  const label = strength === 0 ? '—' : strength === 1 ? 'Fraca' : strength === 2 ? 'Média' : 'Forte'
  const labelColor =
    strength === 0
      ? 'text-text-tertiary'
      : strength === 1
        ? 'text-text-error-primary'
        : strength === 2
          ? 'text-notification-information-foreground'
          : 'text-state-success-text'

  return (
    <div className="flex flex-col gap-2" data-testid="password-strength">
      <div className="flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-background-tertiary-default">
          <div
            className={cx('h-full rounded-full transition-all duration-300', barColor)}
            style={{ width: password.length === 0 ? 0 : `${(score / checks.length) * 100}%` }}
          />
        </div>
        <span className={cx('text-caption-1-semibold', labelColor)}>{label}</span>
      </div>
      {password.length > 0 && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {checks.map((check) => (
            <div key={check.label} className="flex items-center gap-1.5">
              {check.passed ? (
                <RiCheckboxCircleFill className="size-3 shrink-0 text-state-success-text" aria-hidden />
              ) : (
                <RiCloseCircleFill className="size-3 shrink-0 text-foreground-icon-quaternary" aria-hidden />
              )}
              <span
                className={cx(
                  'text-caption-1-regular',
                  check.passed ? 'text-text-primary' : 'text-text-tertiary',
                )}
              >
                {check.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
