import { sql, type Db } from '@comprova/db'
import type { FastifyInstance } from 'fastify'

export interface HealthDeps {
  readonly db: Db
  readonly redis: { ping(): Promise<unknown> }
}

export const registerHealthRoutes = (app: FastifyInstance, deps: HealthDeps): void => {
  app.get('/healthz', async () => ({ status: 'ok' }))

  app.get('/readyz', async (_request, reply) => {
    try {
      await deps.db.execute(sql`SELECT 1`)
      await deps.redis.ping()
      return { status: 'ok', checks: { postgres: 'ok', redis: 'ok' } }
    } catch {
      reply.code(503)
      return { status: 'error' }
    }
  })
}
