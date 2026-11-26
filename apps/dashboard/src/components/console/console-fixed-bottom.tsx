'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Maximize2, Minimize2, Play, Terminal, X } from 'lucide-react'
import { cx } from '@/utils/cx'
import { useConsole } from './console-context'

export interface ConsoleLog {
  readonly id: string
  readonly time: string
  readonly level: 'INFO' | 'SYS' | 'RES' | 'ERROR' | 'WARN' | 'API' | 'STORAGE'
  readonly message: string
  readonly payload?: string
  readonly response?: string
}

const levelStyles: Record<ConsoleLog['level'], string> = {
  INFO: 'text-blue-600 dark:text-blue-400',
  SYS: 'text-purple-600 dark:text-purple-400',
  RES: 'text-emerald-600 dark:text-emerald-400',
  ERROR: 'text-red-600 dark:text-red-400',
  WARN: 'text-amber-600 dark:text-amber-400',
  API: 'text-cyan-600 dark:text-cyan-400',
  STORAGE: 'text-orange-600 dark:text-orange-400',
}

const statusStyles: Record<string, string> = {
  idle: 'bg-muted text-muted-foreground',
  running: 'bg-blue-500 text-white animate-pulse',
  success: 'bg-emerald-500 text-white',
  error: 'bg-red-500 text-white',
}

const statusLabels: Record<string, string> = {
  idle: 'Idle',
  running: 'Running',
  success: 'Success',
  error: 'Error',
}

interface ConsoleFixedBottomProps {
  readonly className?: string
}

export function ConsoleFixedBottom({ className }: ConsoleFixedBottomProps) {
  const { logs, clearLogs, setStatus, status } = useConsole()
  const [isExpanded, setIsExpanded] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [logs, scrollToBottom])

  const copyLogs = useCallback(() => {
    const text = logs.map((l) => `[${l.time} ${l.level}] ${l.message}`).join('\n')
    navigator.clipboard.writeText(text)
  }, [logs])

  const toggleExpand = useCallback(() => setIsExpanded((prev) => !prev), [])

  const headerHeight = 44
  const expandedHeight = 340

  return (
    <div
      className={cx(
        'absolute bottom-0 left-0 right-0 z-50 flex flex-col',
        isExpanded ? `h-[${expandedHeight}px]` : `h-[${headerHeight}px]`,
        'transition-all duration-300 ease-in-out overflow-hidden',
        className,
      )}
    >
      {/* Header do console */}
      <div
        className={cx(
          'flex items-center justify-between px-4 py-2 bg-border-border border-t border-border-border',
          'cursor-pointer hover:bg-muted/50 transition-colors',
        )}
        onClick={toggleExpand}
      >
        <div className="flex items-center gap-2">
          <Terminal className="size-4" aria-hidden />
          <span className="text-xs font-medium text-foreground">Console de Operações</span>
          <span className={cx('ml-auto px-2 py-0.5 rounded-full text-xs font-medium', statusStyles[status])}>
            {statusLabels[status]}
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
            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            aria-label={isExpanded ? 'Minimizar' : 'Expandir'}
          >
            {isExpanded ? (
              <Minimize2 className="size-3.5" aria-hidden />
            ) : (
              <Maximize2 className="size-3.5" aria-hidden />
            )}
          </button>
        </div>
      </div>

      {/* Área de logs expandida */}
      {isExpanded && (
        <div
          className="flex-1 bg-background border-t border-border-border p-3 overflow-y-auto"
          ref={scrollRef}
        >
          <div className="space-y-1.5">
            {logs.length === 0 ? (
              <p className="text-xs text-muted-foreground italic text-center py-4">
                Nenhum log registrado. Os logs da execução aparecerão aqui.
              </p>
            ) : (
              logs.map((log) => (
                <div
                  key={log.id}
                  className="flex gap-2 text-xs font-mono leading-tight p-1.5 rounded border border-transparent hover:border-border-button-default transition-colors group"
                >
                  <span className={cx('font-medium shrink-0 min-w-[60px]', levelStyles[log.level])}>
                    [{log.time} {log.level}]
                  </span>
                  <span className="text-text-secondary truncate">{log.message}</span>
                  {log.payload && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        alert(`Payload:\n${log.payload}`)
                      }}
                      className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-bg-muted/50"
                      aria-label="Ver payload"
                    >
                      <Terminal className="size-3" aria-hidden />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
          <div className="mt-2 pt-2 border-t border-border-border flex items-center justify-between">
            <button
              className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-blue-500 text-white text-xs font-medium hover:bg-blue-600 transition-colors"
              disabled={status === 'running'}
              onClick={() => setStatus('running')}
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
