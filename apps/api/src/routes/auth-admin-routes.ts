import type { FastifyInstance } from 'fastify'
import type { AuthAdmin } from '../auth-admin.js'
import { randomUUID } from 'node:crypto'
import { hash as argon2Hash } from '@node-rs/argon2'
import * as t from '@comprova/db'
import { createDbPool, eq } from '@comprova/db'

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
        // Preserva a origem pública da requisição (x-forwarded-proto/host ou
        // origin) para que o Better Auth gere cookies e redirects com a URL
        // pública correta em vez de http://localhost.
        const proto = (request.headers['x-forwarded-proto'] as string | undefined) ?? 'http'
        const host =
          (request.headers['x-forwarded-host'] as string | undefined) ?? request.headers.host ?? 'localhost'
        const url = `${proto}://${host}${betterAuthPath}`
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

  // --- Endpoint de bootstrap: cria o usuário admin inicial ---
  // Permite criar o primeiro admin sem precisar de SQL direto no Supabase.
  app.post('/api/_debug/create-admin-user', async (request, reply) => {
    try {
      const { email, password, name } = request.body as {
        email?: string
        password?: string
        name?: string
      }
      if (!email || !password) {
        return reply.code(400).send({ error: 'email e password são obrigatórios' })
      }

      const adminUrl = process.env.DATABASE_ADMIN_URL
      if (!adminUrl) {
        return reply.code(500).send({ error: 'DATABASE_ADMIN_URL não configurado' })
      }

      const pool = createDbPool(adminUrl, { max: 1 })
      try {
        // Verificar se já existe
        const existing = await pool.db
          .select({ id: t.adminAuthUser.id })
          .from(t.adminAuthUser)
          .where(eq(t.adminAuthUser.email, email))
          .limit(1)
        if (existing.length > 0) {
          return reply.send({
            ok: true,
            message: 'Usuário já existe',
            email,
          })
        }

        // Gerar hash argon2id (mesmo padrão do better-auth)
        const passwordHash = await argon2Hash(password)

        const userId = randomUUID()
        const displayName = name || email.split('@')[0]
        const displayNameOrDefault = (displayName ?? 'Admin')
        await pool.db.insert(t.adminAuthUser).values({
          id: userId,
          name: displayNameOrDefault,
          email,
          emailVerified: true,
          image: null,
          role: 'superadmin',
          banned: false,
          banReason: null,
          banExpires: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })

        await pool.db.insert(t.adminAuthAccount).values({
          id: randomUUID(),
          accountId: email,
          providerId: 'credential',
          userId,
          password: passwordHash,
          accessToken: null,
          refreshToken: null,
          idToken: null,
          accessTokenExpiresAt: null,
          refreshTokenExpiresAt: null,
          scope: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })

        return reply.send({
          ok: true,
          message: 'Usuário admin criado com sucesso',
          email,
          role: 'superadmin',
        })
      } finally {
        await pool.end()
      }
    } catch (err) {
      app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'create-admin-user error')
      return reply.code(500).send({ error: err instanceof Error ? err.message : 'Erro interno' })
    }
  })
}
