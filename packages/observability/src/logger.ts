import pino from 'pino'
import { redactDeep, redactString } from './redact.js'

export interface Logger {
  debug(arg: string | Record<string, unknown>, msg?: string): void
  info(arg: string | Record<string, unknown>, msg?: string): void
  warn(arg: string | Record<string, unknown>, msg?: string): void
  error(arg: string | Record<string, unknown>, msg?: string): void
  child(bindings: Record<string, unknown>): Logger
}

export interface CreateLoggerOptions {
  level?: string
  base?: Record<string, unknown>
  stream?: { write(line: string): void }
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const inner = pino(
    {
      level: opts.level ?? 'info',
      base: opts.base,
    },
    opts.stream,
  )

  const makeLevel =
    (level: 'debug' | 'info' | 'warn' | 'error') => (arg: string | Record<string, unknown>, msg?: string) => {
      if (typeof arg === 'string') {
        inner[level](redactString(arg))
        return
      }
      inner[level](redactDeep(arg) as Record<string, unknown>, msg)
    }

  return {
    debug: makeLevel('debug'),
    info: makeLevel('info'),
    warn: makeLevel('warn'),
    error: makeLevel('error'),
    child(bindings: Record<string, unknown>) {
      return createLogger({ level: opts.level, base: { ...opts.base, ...bindings } })
    },
  }
}
