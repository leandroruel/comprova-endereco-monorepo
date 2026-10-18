import { describe, expect, it } from 'vitest'
import { cacheable, type CacheStore } from './cache.js'

const makeMemoryCache = (): CacheStore & { readonly entries: Map<string, unknown> } => {
  const entries = new Map<string, unknown>()
  return {
    entries,
    get: async <T>(key: string): Promise<T | null> => (entries.has(key) ? (entries.get(key) as T) : null),
    set: async <T>(key: string, value: T): Promise<void> => {
      entries.set(key, value)
    },
    del: async (key: string): Promise<void> => {
      entries.delete(key)
    },
    delPattern: async (): Promise<number> => 0,
    stats: () => ({ hits: 0, misses: 0, sets: 0, errors: 0 }),
  }
}

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('cacheable', () => {
  it('serve da cache na segunda leitura', async () => {
    const cache = makeMemoryCache()
    let calls = 0
    const fetch = async () => {
      calls++
      return `valor-${calls}`
    }

    expect(await cacheable(cache, 'k', 60, fetch)).toBe('valor-1')
    expect(await cacheable(cache, 'k', 60, fetch)).toBe('valor-1')
    expect(calls).toBe(1)
  })

  it('coalesce leituras concorrentes com a chave fria', async () => {
    const cache = makeMemoryCache()
    let calls = 0
    const gate = deferred<string>()
    const fetch = async () => {
      calls++
      return gate.promise
    }

    const all = Promise.all([
      cacheable(cache, 'k', 60, fetch),
      cacheable(cache, 'k', 60, fetch),
      cacheable(cache, 'k', 60, fetch),
    ])
    gate.resolve('valor')

    expect(await all).toEqual(['valor', 'valor', 'valor'])
    expect(calls).toBe(1)
  })

  it('não cruza chaves diferentes', async () => {
    const cache = makeMemoryCache()
    const calls: string[] = []
    const fetch = (tag: string) => async () => {
      calls.push(tag)
      return tag
    }

    const [a, b] = await Promise.all([
      cacheable(cache, 'a', 60, fetch('a')),
      cacheable(cache, 'b', 60, fetch('b')),
    ])

    expect([a, b]).toEqual(['a', 'b'])
    expect(calls.length).toBe(2)
  })

  it('compartilha a falha concorrente e permite nova tentativa', async () => {
    const cache = makeMemoryCache()
    let calls = 0
    const fetch = async () => {
      calls++
      if (calls === 1) throw new Error('boom')
      return 'ok'
    }

    const [first, second] = await Promise.allSettled([
      cacheable(cache, 'k', 60, fetch),
      cacheable(cache, 'k', 60, fetch),
    ])

    expect(first.status).toBe('rejected')
    expect(second.status).toBe('rejected')
    expect(calls).toBe(1)

    // A promessa que falhou sai do mapa: a leitura seguinte tenta de novo.
    expect(await cacheable(cache, 'k', 60, fetch)).toBe('ok')
    expect(calls).toBe(2)
  })
})
