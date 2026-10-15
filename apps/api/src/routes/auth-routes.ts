import { toNodeHandler } from 'better-auth/node'
import type { FastifyInstance } from 'fastify'
import type { Auth } from '../auth.js'

export const registerAuthRoutes = (app: FastifyInstance, auth: Auth): void => {
  const handler = toNodeHandler(auth)

  app.route({
    method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    url: '/auth/*',
    handler: (request, reply) => {
      reply.hijack()
      handler(request.raw, reply.raw)
    },
  })
}
