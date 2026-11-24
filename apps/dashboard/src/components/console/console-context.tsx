'use client'

import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

export interface ConsoleLog {
  readonly id: string
  readonly time: string
  readonly level: 'INFO' | 'SYS' | 'RES' | 'ERROR' | 'WARN' | 'API' | 'STORAGE'
  readonly message: string
  readonly payload?: string
  readonly response?: string
}

type ConsoleContextValue = {
  readonly logs: readonly ConsoleLog[]
  readonly addLog: (level: ConsoleLog['level'], message: string, payload?: string, response?: string) => void
  readonly clearLogs: () => void
  readonly setStatus: (status: 'idle' | 'running' | 'success' | 'error') => void
  readonly status: 'idle' | 'running' | 'success' | 'error'
}

const ConsoleContext = createContext<ConsoleContextValue | undefined>(undefined)

export function useConsole(): ConsoleContextValue {
  const ctx = useContext(ConsoleContext)
  if (ctx === undefined) {
    throw new Error('useConsole deve ser usado dentro de um <ConsoleProvider>')
  }
  return ctx
}

export function ConsoleProvider({ children }: { children: ReactNode }) {
  const [logs, setLogs] = useState<ConsoleLog[]>([])
  const [status, setStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle')

  const addLog = useCallback(
    (level: ConsoleLog['level'], message: string, payload?: string, response?: string) => {
      const now = new Date()
      const time = now.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
      const id = `${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`
      setLogs((prev) => [...prev, { id, time, level, message, payload, response }])
    },
    [],
  )

  const clearLogs = useCallback(() => {
    setLogs([])
  }, [])

  const value = useMemo<ConsoleContextValue>(
    () => ({ logs, addLog, clearLogs, setStatus, status }),
    [logs, addLog, clearLogs, setStatus, status],
  )

  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>
}
