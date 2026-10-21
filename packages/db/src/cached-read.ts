import type { CacheStore } from './cache.js'

/** Marcador explícito de ausência: distingue "não existe" de cache miss (`null`). */
export const CACHED_NULL = '__CACHED_NULL__'

interface ReadThroughOptions<T> {
  readonly cache: CacheStore
  readonly key: string
  readonly ttlSeconds: number
  readonly load: () => Promise<T | null>
  /** Valor devolvido quando o recurso não existe (também é o que fica no cache). */
  readonly fallback: T
  /** Ausência que não é `null` (ex.: lista vazia). */
  readonly missingWhen?: (value: T) => boolean
}

/**
 * Leitura cache-first com marcador explícito de ausência (`CACHED_NULL`): um
 * `null`/vazio de negócio não se confunde com cache miss.
 */
export const readThrough = async <T>({
  cache,
  key,
  ttlSeconds,
  load,
  fallback,
  missingWhen,
}: ReadThroughOptions<T>): Promise<T> => {
  const cached = await cache.get<T | typeof CACHED_NULL>(key)
  if (cached === CACHED_NULL) return fallback
  if (cached !== null) return cached
  const fresh = await load()
  if (fresh === null || missingWhen?.(fresh) === true) {
    await cache.set(key, CACHED_NULL, ttlSeconds)
    return fallback
  }
  await cache.set(key, fresh, ttlSeconds)
  return fresh
}

/** Variante para leituras que sempre têm valor (nunca há ausência a marcar). */
export const readThroughValue = async <T>(
  cache: CacheStore,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> => {
  const cached = await cache.get<T>(key)
  if (cached !== null) return cached
  const fresh = await load()
  await cache.set(key, fresh, ttlSeconds)
  return fresh
}
