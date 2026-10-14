import type { Metrics } from '@comprova/observability'
import type { FastifyInstance } from 'fastify'

export function registerMetricsRoute(app: FastifyInstance, metrics: Metrics): void {
  app.get('/metrics', async (_request, reply) => {
    reply.type(metrics.registry.contentType)
    return await metrics.registry.metrics()
  })
}
