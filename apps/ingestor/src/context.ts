import { createDbPool, defaultReferenceMigrationsDir, runMigrations, type Db } from '@comprova/db'
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
  /** Pool efêmero no database de referência (mesmo padrão de `withDb`). */
  readonly withRefDb: <T>(maxConnections: number, fn: (db: Db) => Promise<T>) => Promise<T>
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
  withRefDb: async <T>(maxConnections: number, fn: (db: Db) => Promise<T>): Promise<T> => {
    const pool = createDbPool(config.refAdminUrl, { max: maxConnections })
    try {
      return await fn(pool.db)
    } finally {
      await pool.end()
    }
  },
})

/**
 * Migrations do database de referência (CNEFE/Receita). No modo
 * single-database (`refAdminUrl === adminUrl`) é no-op: as estruturas já vêm
 * das migrations operacionais (0003/0009/0018) e os arquivos em
 * `migrations-reference/` têm DDL para database de referência puro — eles não
 * podem ser aplicados sobre o database operacional.
 */
export const runReferenceMigrations = async (context: IngestorContext): Promise<void> => {
  if (context.config.refAdminUrl === context.config.adminUrl) return
  await runMigrations({
    adminUrl: context.config.refAdminUrl,
    migrationsDir: defaultReferenceMigrationsDir(),
  })
}
