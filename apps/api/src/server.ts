import { createLogger, createMetrics } from '@comprova/observability'
import { createDbPool } from '@comprova/db'
import Redis from 'ioredis'
import { buildApp, buildFastPathDeps } from './app.js'
import { loadConfig } from './config.js'
import { startBatchLoop } from './services/batch-processor.js'
import { startPublisherLoop } from './services/outbox-publisher.js'

const config = loadConfig()
const logger = createLogger({ level: config.LOG_LEVEL, base: { service: 'api' } })
const pool = createDbPool(config.DATABASE_URL)
const adminPool = config.DATABASE_ADMIN_URL !== undefined ? createDbPool(config.DATABASE_ADMIN_URL) : null
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true })
const metrics = createMetrics()

const app = await buildApp({ config, db: pool.db, redis, logger, metrics })

const stopPublisher = config.WORKER_LOOPS
  ? startPublisherLoop({ db: pool.db, pepper: config.API_KEY_PEPPER, logger }, 2_000)
  : null
const stopBatch =
  adminPool !== null
    ? startBatchLoop({ adminDb: adminPool.db, fastPath: buildFastPathDeps(pool.db, config) }, 1_000)
    : null

const shutdown = async (): Promise<void> => {
  logger.info('graceful shutdown started')
  stopPublisher?.()
  stopBatch?.()
  try {
    await app.close()
    await pool.end()
    if (adminPool !== null) await adminPool.end()
    redis.disconnect()
  } finally {
    process.exit(0)
  }
}

process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())

await redis.connect()
await app.listen({ port: config.PORT, host: config.HOST })
logger.info(
  {
    port: config.PORT,
    host: config.HOST,
    temporal_enabled: config.TEMPORAL_ENABLED,
    worker_loops: config.WORKER_LOOPS,
  },
  'api listening',
)
