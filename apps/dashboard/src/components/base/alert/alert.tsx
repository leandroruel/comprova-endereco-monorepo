'use client'

import type { HTMLAttributes, Ref } from 'react'
import { cx, sortCx } from '@/utils/cx'
import { RiAlertLine, RiCloseLine, RiInformationLine } from '@remixicon/react'
import { type AlertVariant, useAlerts } from './alert-context.js'

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant
  title?: string
  message?: string
  closable?: boolean
  onClose?: () => void
  className?: string
  ref?: Ref<HTMLDivElement>
}

/**
 * Renderiza todos os alertas globais na ordem em que foram adicionados.
 * Coloque no topo do layout (acima do conteúdo) para máxima visibilidade.
 */
export function Alerts({ className }: { className?: string }) {
  const { alerts, remove } = useAlerts()
  return (
    <div className={cx('flex flex-col gap-2 w-full pointer-events-none', className)}>
      {alerts.map((alert) => (
        <Alert key={alert.id} {...alert} closable onClose={() => remove(alert.id)} />
      ))}
    </div>
  )
}

const styles = sortCx({
  base: [
    'flex items-start gap-3 rounded-xl border p-3 pointer-events-auto',
    'text-body-regular leading-snug',
  ].join(' '),

  variant: {
    error: ['bg-status-rose-background border-border-error-default text-status-rose-text'].join(' '),
    warning: ['bg-status-orange-background border-border-error-default text-status-orange-text'].join(' '),
    info: ['bg-status-blue-background border-border-button-default text-status-blue-text'].join(' '),
  },

  icon: {
    error: 'size-5 shrink-0 text-status-rose-text',
    warning: 'size-5 shrink-0 text-status-orange-text',
    info: 'size-5 shrink-0 text-status-blue-text',
  },

  close: 'size-6 rounded-md p-1 shrink-0 opacity-60 hover:opacity-100 transition-opacity',
})

export function Alert({
  variant = 'info',
  title,
  message,
  closable = true,
  onClose,
  className,
  ref,
  ...props
}: AlertProps) {
  const Icon = variant === 'error' ? RiAlertLine : variant === 'warning' ? RiAlertLine : RiInformationLine

  return (
    <div
      ref={ref}
      className={cx(styles.base, styles.variant[variant], className)}
      role="alert"
      aria-live="polite"
      {...props}
    >
      <Icon className={styles.icon[variant]} aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold text-body-medium">{title}</p>}
        {message && <p className={cx(title ? 'mt-0.5' : '', 'text-body-regular')}>{message}</p>}
      </div>
      {closable && (
        <button type="button" className={styles.close} onClick={onClose} aria-label="Fechar alerta">
          <RiCloseLine className="size-4 shrink-0" aria-hidden />
        </button>
      )}
    </div>
  )
}
