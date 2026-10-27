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
  pretty?: boolean
}

interface PinoLike {
  debug: (obj: unknown, msg?: unknown) => void
  info: (obj: unknown, msg?: unknown) => void
  warn: (obj: unknown, msg?: unknown) => void
  error: (obj: unknown, msg?: unknown) => void
  child: (bindings: Record<string, unknown>) => PinoLike
}

function buildPino(opts: CreateLoggerOptions = {}): PinoLike {
  const inner = pino(
    {
      level: opts.level ?? 'info',
      base: opts.base,
      ...(opts.pretty
        ? {
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: process.env.LOG_COLOR !== 'false',
                translateTime: 'HH:MM:ss',
                ignore: 'pid,hostname',
              },
            },
          }
        : {}),
    },
    opts.stream,
  )
  return inner as unknown as PinoLike
}

function wrap(inner: PinoLike): Logger {
  const emit =
    (level: 'debug' | 'info' | 'warn' | 'error') => (arg: string | Record<string, unknown>, msg?: string) => {
      const obj = typeof arg === 'string' ? redactString(arg) : redactDeep(arg)
      if (msg !== undefined) {
        inner[level](obj, msg)
      } else {
        inner[level](obj)
      }
    }

  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child(bindings: Record<string, unknown>): Logger {
      return wrap(inner.child(bindings))
    },
  }
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  return wrap(buildPino(opts))
}

export function createCLILogger(service: string, level = 'info'): Logger {
  return createLogger({ level, base: { service }, pretty: true })
}
