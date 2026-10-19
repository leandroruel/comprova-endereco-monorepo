import { createDbPool, runMigrations, type Db } from '@comprova/db'
import type { Logger } from '@comprova/observability'
import type { IngestorConfig } from './config.js'

/**
 * Contexto de composição compartilhado pelos comandos: configuração já
 * validada, logger e os efeitos transversais (migrations e ciclo de vida do
 * pool). Os comandos ficam livres de `process.env` e do boilerplate
 * create/`try`/`end` do pool.
 */
export interface IngestorContext {
  readonly config: IngestorConfig
  readonly logger: Logger
  readonly runMigrations: () => Promise<void>
  readonly withDb: <T>(maxConnections: number, fn: (db: Db) => Promise<T>) => Promise<T>
}

export const makeIngestorContext = (config: IngestorConfig, logger: Logger): IngestorContext => ({
  config,
  logger,
  runMigrations: () => runMigrations({ adminUrl: config.adminUrl, rolePassword: config.appDbPassword }),
  withDb: async <T>(maxConnections: number, fn: (db: Db) => Promise<T>): Promise<T> => {
    const pool = createDbPool(config.adminUrl, { max: maxConnections })
    try {
      return await fn(pool.db)
    } finally {
      await pool.end()
    }
  },
})
