import type Redis from 'ioredis'
import { Buffer } from 'node:buffer'

export interface CacheLogger {
  readonly warn: (obj: Record<string, unknown>, msg: string) => void
  readonly info: (obj: Record<string, unknown>, msg: string) => void
}

export interface CacheStore {
  readonly get: <T>(key: string) => Promise<T | null>
  readonly set: <T>(key: string, value: T, ttlSeconds: number) => Promise<void>
  readonly del: (key: string) => Promise<void>
  readonly delPattern: (pattern: string) => Promise<number>
  readonly stats: () => { hits: number; misses: number; sets: number; errors: number }
}

const reviveBuffer = (_key: string, value: unknown): unknown =>
  value !== null &&
  typeof value === 'object' &&
  (value as { type?: unknown }).type === 'Buffer' &&
  Array.isArray((value as { data?: unknown }).data)
    ? Buffer.from((value as { data: number[] }).data)
    : value

export const makeRedisCache = (redis: Redis, logger?: CacheLogger): CacheStore => {
  const stats = { hits: 0, misses: 0, sets: 0, errors: 0 }

  return {
    get: async <T>(key: string): Promise<T | null> => {
      try {
        const raw = await redis.get(key)
        if (raw === null) {
          stats.misses++
          return null
        }
        stats.hits++
        return JSON.parse(raw, reviveBuffer) as T
      } catch (err) {
        stats.errors++
        logger?.warn({ err: err instanceof Error ? err.message : String(err), key }, 'cache get failed')
        return null
      }
    },

    set: async <T>(key: string, value: T, ttlSeconds: number): Promise<void> => {
      try {
        await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds)
        stats.sets++
      } catch (err) {
        stats.errors++
        logger?.warn({ err: err instanceof Error ? err.message : String(err), key }, 'cache set failed')
      }
    },

    del: async (key: string): Promise<void> => {
      try {
        await redis.del(key)
      } catch (err) {
        stats.errors++
        logger?.warn(
          {
            err: err instanceof Error ? (err instanceof Error ? err.message : String(err)) : String(err),
            key,
          },
          'cache del failed',
        )
      }
    },

    delPattern: async (pattern: string): Promise<number> => {
      try {
        const keys = await redis.keys(pattern)
        if (keys.length === 0) return 0
        const pipeline = redis.pipeline()
        for (const key of keys) pipeline.del(key)
        const results = (await pipeline.exec()) as Array<[Error | null, unknown]> | null
        const deleted = results?.filter(([e, v]) => e === null && v === 1).length ?? 0
        logger?.info({ pattern, deleted }, 'cache pattern invalidated')
        return deleted
      } catch (err) {
        stats.errors++
        logger?.warn(
          { err: err instanceof Error ? err.message : String(err), pattern },
          'cache delPattern failed',
        )
        return 0
      }
    },

    stats: () => ({ ...stats }),
  }
}

// Leituras concorrentes com a chave fria compartilham a mesma execução. Sem
// isso, todo request que chega antes do `set` roda o `fetch` por conta própria:
// num `fetch` que faz varredura cara (ex.: os `MAX()` de `meta:datasets:v1`), a
// virada do TTL dispara N varreduras idênticas em vez de uma. O coalescing é
// por chave e por processo — com réplicas, o teto é uma execução por réplica.
const inFlight = new Map<string, Promise<unknown>>()

const fetchAndCache = async <T>(
  cache: CacheStore,
  key: string,
  ttlSeconds: number,
  fetch: () => Promise<T>,
): Promise<T> => {
  try {
    const fresh = await fetch()
    if (fresh !== null && fresh !== undefined) {
      await cache.set(key, fresh, ttlSeconds)
    }
    return fresh
  } finally {
    // Uma falha não pode ficar em voo para sempre: quem chegar depois tenta de novo.
    inFlight.delete(key)
  }
}

export const cacheable = async <T>(
  cache: CacheStore,
  key: string,
  ttlSeconds: number,
  fetch: () => Promise<T>,
): Promise<T> => {
  const cached = await cache.get<T>(key)
  if (cached !== null) return cached

  const pending = inFlight.get(key) as Promise<T> | undefined
  if (pending !== undefined) return pending

  const promise = fetchAndCache(cache, key, ttlSeconds, fetch)
  inFlight.set(key, promise)
  return promise
}
