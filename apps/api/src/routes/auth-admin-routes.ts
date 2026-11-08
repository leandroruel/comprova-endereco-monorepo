import type { FastifyInstance } from 'fastify'
import type { AuthAdmin } from '../auth-admin.js'

/**
 * Proxy de rotas de auth do admin para o handler do Better Auth.
 *
 * O Better Auth expõe endpoints sob `/api/auth/*` (ex: sign-in/email,
 * sign-up/email, get-session, sign-out). Este proxy monta o handler sob
 * `/v1/auth/admin/*`, reescrevendo o path para remover o segmento `/admin`
 * antes de entregar ao handler.
 */
export const registerAuthAdminRoutes = (app: FastifyInstance, auth: AuthAdmin): void => {
  app.route({
    method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    url: '/v1/auth/admin/*',
    handler: async (request, reply) => {
      try {
        const authPath = request.raw.url ?? '/v1/auth/admin/get-session'
        // Remove o segmento /admin para expor o path esperado pelo Better Auth
        // (/api/auth/...).
        const betterAuthPath = authPath.replace(/\/v1\/auth\/admin\//, '/api/auth/')
        const url = `http://localhost${betterAuthPath}`
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
        app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'auth admin handler error')
        reply.status(500).send({ error: 'auth admin handler failed' })
      }
    },
  })
}
