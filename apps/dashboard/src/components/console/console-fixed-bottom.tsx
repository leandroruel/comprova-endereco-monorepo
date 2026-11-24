'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Minimize, Plus, Play, Terminal, X } from 'lucide-react'
import { cx } from '@/utils/cx'

export interface ConsoleLog {
  readonly id: string
  readonly time: string
  readonly level: 'INFO' | 'SYS' | 'RES' | 'ERROR' | 'WARN'
  readonly message: string
}

export interface ConsoleFixedBottomProps {
  readonly initialLogs?: ConsoleLog[]
  readonly className?: string
}

const INITIAL_LOGS: ConsoleLog[] = [
  {
    id: '1',
    time: '14:22:10',
    level: 'INFO',
    message: 'Sistema inicializado. Aguardando entrada de identificador fiscal.',
  },
  { id: '2', time: '14:22:11', level: 'SYS', message: 'Gateway v2.4 conectado e pronto.' },
  { id: '3', time: '14:22:12', level: 'INFO', message: 'API Receita Federal: Online' },
]

export function ConsoleFixedBottom({ initialLogs = INITIAL_LOGS, className }: ConsoleFixedBottomProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [logs, setLogs] = useState<ConsoleLog[]>(initialLogs)
  const [status, setStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle')
  const scrollRef = useRef<HTMLDivElement>(null)

  const addLog = useCallback((level: ConsoleLog['level'], message: string) => {
    const now = new Date()
    const time = now.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    const id = `${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`
    setLogs((prev) => [...prev, { id, time, level, message }])
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [logs, scrollToBottom])

  const clearLogs = useCallback(() => {
    setLogs([])
  }, [])

  const copyLogs = useCallback(() => {
    const text = logs.map((l) => `[${l.time} ${l.level}] ${l.message}`).join('\n')
    navigator.clipboard.writeText(text)
  }, [logs])

  const runValidation = useCallback(() => {
    setStatus('running')
    addLog('INFO', 'Validação iniciada para CNPJ: 33.986.713/0001-04')
    setTimeout(() => {
      addLog('SYS', 'Chamada efetuada para API Receita Federal (v2.4)')
    }, 500)
    setTimeout(() => {
      addLog('RES', 'Resultado: Situação Ativa. Confiança: 98%')
      setStatus('success')
    }, 1200)
  }, [addLog])

  const levelStyles: Record<ConsoleLog['level'], string> = {
    INFO: 'text-blue-600 dark:text-blue-400',
    SYS: 'text-purple-600 dark:text-purple-400',
    RES: 'text-emerald-600 dark:text-emerald-400',
    ERROR: 'text-red-600 dark:text-red-400',
    WARN: 'text-amber-600 dark:text-amber-400',
  }

  const statusStyles: Record<string, string> = {
    idle: 'bg-muted text-muted-foreground',
    running: 'bg-blue-500 text-white animate-pulse',
    success: 'bg-emerald-500 text-white',
    error: 'bg-red-500 text-white',
  }

  const headerHeight = 44
  const expandedHeight = 320

  return (
    <div
      className={cx(
        'fixed bottom-0 left-0 right-0 z-50 flex flex-col',
        isExpanded ? `h-[${expandedHeight}px]` : `h-[${headerHeight}px]`,
        'transition-all duration-300 ease-in-out overflow-hidden',
        className,
      )}
    >
      {/* Header fixo do console */}
      <div
        className={cx(
          'flex items-center justify-between px-4 py-2 bg-border-border border-t border-border-border',
          'cursor-pointer hover:bg-muted/50 transition-colors',
        )}
        onClick={() => setIsExpanded((prev) => !prev)}
      >
        <div className="flex items-center gap-2">
          <Terminal className="size-4" aria-hidden />
          <span className="text-xs font-medium text-foreground">Console de Operações</span>
          <span className={cx('ml-auto px-2 py-0.5 rounded-full text-xs font-medium', statusStyles[status])}>
            {status === 'idle'
              ? 'Idle'
              : status === 'running'
                ? 'Running'
                : status === 'success'
                  ? 'Success'
                  : 'Error'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={copyLogs}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Copiar logs"
          >
            <Copy className="size-3.5" aria-hidden />
          </button>
          <button
            onClick={clearLogs}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Limpar logs"
          >
            <X className="size-3.5" aria-hidden />
          </button>
          <button
            onClick={() => setIsExpanded((prev) => !prev)}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            aria-label={isExpanded ? 'Minimizar console' : 'Expandir console'}
          >
            {isExpanded ? (
              <Minimize className="size-3.5" aria-hidden />
            ) : (
              <Plus className="size-3.5" aria-hidden />
            )}
          </button>
        </div>
      </div>

      {/* Área expandível de logs */}
      {isExpanded && (
        <div
          className="flex-1 bg-background border-t border-border-border p-3 overflow-y-auto"
          ref={scrollRef}
        >
          <div className="space-y-1">
            {logs.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">Nenhum log registrado.</p>
            ) : (
              logs.map((log) => (
                <div key={log.id} className="flex items-start gap-2 text-xs font-mono leading-tight">
                  <span className={cx('font-medium', levelStyles[log.level])}>
                    [{log.time} {log.level}]
                  </span>
                  <span className="text-text-secondary">{log.message}</span>
                </div>
              ))
            )}
          </div>
          <div className="mt-2 pt-2 border-t border-border-border flex items-center justify-between">
            <button
              onClick={runValidation}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-blue-500 text-white text-xs font-medium hover:bg-blue-600 transition-colors"
              disabled={status === 'running'}
            >
              <Play className="size-3.5" aria-hidden />
              {status === 'running' ? 'Processando...' : 'Executar Validação'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
