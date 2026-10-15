import type { FastifyInstance } from 'fastify'
import type { Auth } from '../auth.js'

export const registerAuthRoutes = (app: FastifyInstance, auth: Auth): void => {
  app.route({
    method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    url: '/api/auth/*',
    handler: async (request, reply) => {
      try {
        const authPath = request.raw.url ?? '/api/auth/get-session'
        const url = `http://localhost${authPath}`
        const headers = new Headers()
        for (const [key, value] of Object.entries(request.headers)) {
          if (key !== 'host' && key !== 'content-length') {
            const v = Array.isArray(value) ? value.join(',') : value
            if (v !== undefined) headers.set(key, v)
          }
        }
        const body = request.body ? JSON.stringify(request.body) : undefined
        const incoming = new Request(url, { method: request.method, headers, body })
        const response = await auth.handler(incoming)
        reply.status(response.status)
        response.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'x-powered-by') {
            reply.header(key, value)
          }
        })
        const text = await response.text()
        if (text.length > 0) {
          reply.header('content-type', 'application/json')
          reply.send(text)
        } else {
          reply.send()
        }
      } catch (err) {
        app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'auth handler error')
        reply.status(500).send({ error: 'auth handler failed' })
      }
    },
  })
}
