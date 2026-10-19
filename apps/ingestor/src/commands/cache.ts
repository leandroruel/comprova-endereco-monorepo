import type { CacheStore } from '@comprova/db'
import type { CommandHandler } from './types.js'

interface CacheTarget {
  readonly invalidate: (cache: CacheStore) => Promise<void>
  readonly message: string
}

export const cacheFlush: CommandHandler = async (context, args) => {
  const target = args[0] ?? 'all'
  const Redis = (await import('ioredis')).default
  const redis = new Redis(context.config.redisUrl)

  try {
    const { makeRedisCache, cacheKeys } = await import('@comprova/db')
    const cache = makeRedisCache(redis)
    const targets: Readonly<Record<string, CacheTarget>> = {
      all: { invalidate: cacheKeys.invalidateAll, message: 'cache: all keys invalidated' },
      registry: { invalidate: cacheKeys.invalidateRegistry, message: 'cache: registry invalidated' },
      cep: { invalidate: cacheKeys.invalidateCep, message: 'cache: cep invalidated' },
      cnefe: { invalidate: cacheKeys.invalidateCnefe, message: 'cache: cnefe invalidated' },
      profiles: { invalidate: cacheKeys.invalidateProfiles, message: 'cache: profiles invalidated' },
    }

    const entry = targets[target]
    if (entry === undefined) {
      context.logger.info('usage: ingestor cache:flush [all|registry|cep|cnefe|profiles]')
    } else {
      await entry.invalidate(cache)
      context.logger.info(entry.message)
    }
    context.logger.info('cache stats:', JSON.stringify(cache.stats()))
  } finally {
    redis.disconnect()
  }
}
