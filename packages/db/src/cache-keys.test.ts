import { describe, expect, it } from 'vitest'
import type { CacheStore } from './cache.js'
import { cacheKeys } from './cache-keys.js'

const makeRecordingCache = (): CacheStore & { readonly deleted: string[] } => {
  const deleted: string[] = []
  return {
    deleted,
    get: async () => null,
    set: async () => undefined,
    del: async () => undefined,
    delPattern: async (pattern: string): Promise<number> => {
      deleted.push(pattern)
      return 0
    },
    stats: () => ({ hits: 0, misses: 0, sets: 0, errors: 0 }),
  }
}

describe('cacheKeys', () => {
  it('invalidateAll cobre todos os prefixos escritos pelos leitores', async () => {
    const cache = makeRecordingCache()
    await cacheKeys.invalidateAll(cache)

    expect(cache.deleted).toEqual(
      expect.arrayContaining([
        'reg:*',
        'cep:*',
        'cnefe:*',
        'cnefeCoord:*',
        'prof:*',
        'others:*',
        'shared:*',
        'cnae:*',
        'pgraph:*',
        'meta:*',
      ]),
    )
    expect(new Set(cache.deleted).size).toBe(cache.deleted.length)
  })

  it('invalidações específicas apontam para o prefixo do leitor', async () => {
    const cache = makeRecordingCache()
    await cacheKeys.invalidateCnae(cache)
    await cacheKeys.invalidatePartnerGraph(cache)

    expect(cache.deleted).toEqual(['cnae:*', 'pgraph:*'])
  })
})
