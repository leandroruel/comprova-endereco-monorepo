import type { ReactNode } from 'react'
import { AlertProvider } from '@/components/base/alert/alert-context'
import { ConsoleProvider } from '@/components/console/console-context'

/**
 * Providers globais montados em `App.tsx` acima do layout e das páginas.
 * Testes que renderizam componentes isolados precisam do mesmo contexto para
 * que hooks como `useAlerts` e `useConsole` funcionem.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AlertProvider>
      <ConsoleProvider>{children}</ConsoleProvider>
    </AlertProvider>
  )
}
