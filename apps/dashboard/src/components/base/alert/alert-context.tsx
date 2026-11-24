'use client'

import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

export type AlertVariant = 'info' | 'warning' | 'error'

export interface AlertItem {
  readonly id: string
  readonly variant: AlertVariant
  readonly title?: string
  readonly message?: string
}

type AlertContextValue = {
  readonly alerts: readonly AlertItem[]
  readonly add: (item: Omit<AlertItem, 'id'>) => void
  readonly remove: (id: string) => void
  readonly clear: () => void
}

const AlertsContext = createContext<AlertContextValue | undefined>(undefined)

/**
 * Hook global de alertas. Qualquer componente da aplicação pode disparar um
 * alerta (info/warning/error) que será renderizado pelo `<Alerts />` no topo
 * do layout. Ex.: `useAlerts().add({ variant: 'error', message: '...' })`.
 */
export function useAlerts(): AlertContextValue {
  const ctx = useContext(AlertsContext)
  if (ctx === undefined) {
    throw new Error('useAlerts deve ser usado dentro de um <AlertProvider>')
  }
  return ctx
}

/**
 * Fornece o estado global de alertas para a árvore. Renderize um
 * `<Alerts />` em algum lugar do layout (normalmente no topo do dashboard)
 * para que os alertas adicionados via `useAlerts().add` apareçam.
 */
export function AlertProvider({ children }: { children: ReactNode }) {
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const counter = useRef(0)

  const add = useCallback((item: Omit<AlertItem, 'id'>) => {
    const alert: AlertItem = { ...item, id: String(counter.current) }
    counter.current += 1
    setAlerts((prev) => [...prev, alert])
  }, [])

  const remove = useCallback((id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const clear = useCallback(() => setAlerts([]), [])

  const value = useMemo<AlertContextValue>(
    () => ({ alerts, add, remove, clear }),
    [alerts, add, remove, clear],
  )

  return <AlertsContext.Provider value={value}>{children}</AlertsContext.Provider>
}
