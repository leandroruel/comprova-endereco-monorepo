import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from './schema.js'

export type Db = PostgresJsDatabase<typeof schema>
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0]

export interface DbPool {
  readonly db: Db
  readonly end: () => Promise<void>
}

export const createDbPool = (
  url: string,
  options: postgres.Options<Record<string, postgres.PostgresType>> = {},
): DbPool => {
  const client = postgres(url, {
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idle_timeout: 30,
    connect_timeout: 10,
    ...options,
  })
  return {
    db: drizzle(client, { schema }),
    end: () => client.end(),
  }
}

export const withTenant = async <T>(db: Db, tenantId: string, fn: (tx: DbTx) => Promise<T>): Promise<T> =>
  db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`)
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`)
    return fn(tx)
  })
