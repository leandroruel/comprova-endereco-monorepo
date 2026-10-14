import { createLogger, createMetrics } from '@comprova/observability'
import { createDbPool } from '@comprova/db'
import Redis from 'ioredis'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const logger = createLogger({ level: config.LOG_LEVEL, base: { service: 'api' } })
const pool = createDbPool(config.DATABASE_URL)
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true })
const metrics = createMetrics()

const app = await buildApp({ config, db: pool.db, redis, logger, metrics })

const shutdown = async (): Promise<void> => {
  logger.info('graceful shutdown started')
  try {
    await app.close()
    await pool.end()
    redis.disconnect()
  } finally {
    process.exit(0)
  }
}

process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())

await redis.connect()
await app.listen({ port: config.PORT, host: config.HOST })
logger.info({ port: config.PORT, host: config.HOST }, 'api listening')
