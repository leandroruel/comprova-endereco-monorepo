import { randomUUID } from 'node:crypto'
import { PROBLEM_CONTENT_TYPE, problem } from '@comprova/contracts'
import { makeT0Checkers } from '@comprova/checkers'
import { systemClock } from '@comprova/core'
import { type Logger, type Metrics } from '@comprova/observability'
import {
  makeCepReader,
  makeCnaeCategoriaReader,
  makeCnefeReader,
  makeKnownSharedReader,
  makeProfileReader,
  makeRegistryReader,
  type Db,
} from '@comprova/db'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import swagger from '@fastify/swagger'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from '@fastify/type-provider-zod'
import type Redis from 'ioredis'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import type { AppConfig } from './config.js'
import { makeAuthenticate } from './plugins/auth.js'
import { makeRateLimiter } from './plugins/rate-limit.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerMetricsRoute } from './routes/metrics.js'
import { registerValidationRoutes } from './routes/validations.js'
import { docHmacKeyFromPepper } from './services/fastpath.js'
import { loadPolicyFile } from './policy-loader.js'

export interface AppDeps {
  readonly config: AppConfig
  readonly db: Db
  readonly redis: Redis
  readonly logger: Logger
  readonly metrics: Metrics
}

export const buildApp = async (deps: AppDeps): Promise<FastifyInstance> => {
  const app: FastifyInstance = Fastify({
    logger: false,
    genReqId: () => randomUUID(),
  }).withTypeProvider<ZodTypeProvider>()

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  await app.register(helmet)
  await app.register(cors, { origin: false })
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'comprova-endereco', version: '0.1.0' },
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  })

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id)
  })

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unknown'
    const labels = { method: request.method, route }
    deps.metrics.httpRequests.inc({ ...labels, status: reply.statusCode })
    if (reply.statusCode >= 500) {
      deps.metrics.httpErrors.inc(labels)
    }
    deps.metrics.httpDuration.observe(labels, reply.elapsedTime / 1000)
  })

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .type(PROBLEM_CONTENT_TYPE)
      .send(problem(404, 'NOT_FOUND', 'Route not found', request.url))
  })

  app.setErrorHandler((err, request, reply) => {
    if ((err as FastifyError).validation !== undefined) {
      reply
        .code(400)
        .type(PROBLEM_CONTENT_TYPE)
        .send(
          problem(
            400,
            'VALIDATION_ERROR',
            'Request validation failed',
            err instanceof Error ? err.message : undefined,
          ),
        )
      return
    }
    deps.logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        request_id: request.id,
        route: request.routeOptions.url,
      },
      'unhandled error',
    )
    reply
      .code(500)
      .type(PROBLEM_CONTENT_TYPE)
      .send(problem(500, 'INTERNAL_ERROR', 'Internal server error'))
  })

  const authenticate = makeAuthenticate(deps.db, deps.config.API_KEY_PEPPER)
  const rateLimit = makeRateLimiter(deps.redis)

  const registry = makeRegistryReader(deps.db)
  const policy = loadPolicyFile(deps.config.POLICY_VERSION)
  const fastPath = {
    db: deps.db,
    registry,
    checkers: makeT0Checkers({
      registry,
      cnefe: makeCnefeReader(deps.db),
      cep: makeCepReader(deps.db),
      profile: makeProfileReader(deps.db),
      knownShared: makeKnownSharedReader(deps.db),
      cnaeCategoria: makeCnaeCategoriaReader(deps.db),
    }),
    policy,
    clock: systemClock,
    docHmacKey: docHmacKeyFromPepper(deps.config.API_KEY_PEPPER),
  }

  await app.register(
    async (v1) => {
      v1.addHook('preHandler', authenticate)
      v1.addHook('preHandler', rateLimit)
      registerValidationRoutes(v1, { db: deps.db, fastPath })
    },
    { prefix: '/v1' },
  )

  app.get('/openapi.json', async () => app.swagger())

  registerHealthRoutes(app, { db: deps.db, redis: deps.redis })
  registerMetricsRoute(app, deps.metrics)

  return app
}
