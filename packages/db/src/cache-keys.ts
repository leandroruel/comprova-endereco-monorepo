import type { CacheStore } from './cache.js'

/** Invalidação por prefixo das leituras cache-first (ver `cached-readers.ts`). */
export const cacheKeys = {
  invalidateRegistry: async (cache: CacheStore) => {
    await cache.delPattern('reg:*')
  },
  invalidateCep: async (cache: CacheStore) => {
    await cache.delPattern('cep:*')
  },
  invalidateCnefe: async (cache: CacheStore) => {
    await cache.delPattern('cnefe:*')
    await cache.delPattern('cnefeCoord:*')
  },
  invalidateProfiles: async (cache: CacheStore) => {
    await cache.delPattern('prof:*')
    await cache.delPattern('others:*')
  },
  invalidateKnownShared: async (cache: CacheStore) => {
    await cache.delPattern('shared:*')
  },
  invalidateAll: async (cache: CacheStore) => {
    for (const pattern of [
      'reg:*',
      'cep:*',
      'cnefe:*',
      'cnefeCoord:*',
      'prof:*',
      'others:*',
      'shared:*',
      'meta:*',
    ]) {
      await cache.delPattern(pattern)
    }
  },
}
