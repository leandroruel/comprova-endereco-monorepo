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
  file?: string
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
  const stream =
    opts.stream ??
    (opts.file === undefined
      ? undefined
      : pino.multistream([
          { level: opts.level ?? 'info', stream: process.stdout },
          {
            level: opts.level ?? 'info',
            stream: pino.destination({ dest: opts.file, mkdir: true, sync: true }),
          },
        ]))
  const inner = pino(
    {
      level: opts.level ?? 'info',
      base: opts.base,
      // When a file is configured, keep JSON on both stdout and the file so
      // Filebeat can decode the same structured event that the terminal sees.
      ...(opts.pretty && opts.file === undefined
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
    stream,
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
