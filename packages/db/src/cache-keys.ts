import type { CacheStore } from './cache.js'

/**
 * Prefixos escritos por `cached-readers.ts`. `invalidateAll` deriva daqui, de
 * modo que um leitor novo não fica de fora da invalidação total por engano.
 */
const PREFIXES = {
  registry: ['reg:*'],
  cep: ['cep:*'],
  cnefe: ['cnefe:*', 'cnefeCoord:*'],
  profiles: ['prof:*', 'others:*'],
  knownShared: ['shared:*'],
  cnae: ['cnae:*'],
  partnerGraph: ['pgraph:*'],
  meta: ['meta:*'],
} as const satisfies Record<string, readonly string[]>

const invalidate = async (cache: CacheStore, patterns: readonly string[]): Promise<void> => {
  for (const pattern of patterns) {
    await cache.delPattern(pattern)
  }
}

/** Invalidação por prefixo das leituras cache-first (ver `cached-readers.ts`). */
export const cacheKeys = {
  invalidateRegistry: (cache: CacheStore) => invalidate(cache, PREFIXES.registry),
  invalidateCep: (cache: CacheStore) => invalidate(cache, PREFIXES.cep),
  invalidateCnefe: (cache: CacheStore) => invalidate(cache, PREFIXES.cnefe),
  invalidateProfiles: (cache: CacheStore) => invalidate(cache, PREFIXES.profiles),
  invalidateKnownShared: (cache: CacheStore) => invalidate(cache, PREFIXES.knownShared),
  invalidateCnae: (cache: CacheStore) => invalidate(cache, PREFIXES.cnae),
  invalidatePartnerGraph: (cache: CacheStore) => invalidate(cache, PREFIXES.partnerGraph),
  invalidateAll: (cache: CacheStore) => invalidate(cache, Object.values(PREFIXES).flat()),
}
