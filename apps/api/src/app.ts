import { randomUUID } from 'node:crypto'
import { PROBLEM_CONTENT_TYPE, problem } from '@comprova/contracts'
import { makeT0Checkers } from '@comprova/checkers'
import { systemClock } from '@comprova/core'
import { type Logger, type Metrics } from '@comprova/observability'
import {
  EVIDENCE_ARTIFACT_MAX_BYTES,
  makeCepReader,
  makeCnaeCategoriaReader,
  makeCnefeReader,
  makeKnownSharedReader,
  makeProfileReader,
  makeRegistryReader,
  type Db,
} from '@comprova/db'
import { makeS3ObjectStore, makeUnavailableObjectStore, type ObjectStore } from '@comprova/providers'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
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
import { DEFAULT_EVIDENCE_MAX_CONCURRENCY, type AppConfig } from './config.js'
import { makeAuthenticate } from './plugins/auth.js'
import { makeRateLimiter } from './plugins/rate-limit.js'
import { createAuth } from './auth.js'
import { registerAuthRoutes } from './routes/auth-routes.js'
import { makeSessionMiddleware } from './plugins/session.js'
import { makeRedisCache, makeCachedReaders, makeApiKeyHasher } from '@comprova/db'
import { registerHealthRoutes } from './routes/health.js'
import { registerMetricsRoute } from './routes/metrics.js'
import { registerBatchRoutes } from './modules/batches/batches.routes.js'
import { registerCredentialRoutes } from './modules/credentials/credentials.routes.js'
import { registerIssuerRoutes } from './modules/issuers/issuers.routes.js'
import { registerSigningKeyRoutes } from './modules/signing-keys/signing-keys.routes.js'
import { registerMetaRoutes } from './modules/meta/meta.routes.js'
import { registerStatsRoutes } from './modules/stats/stats.routes.js'
import { registerSubjectRoutes } from './modules/subjects/subjects.routes.js'
import { registerValidationRoutes } from './modules/validations/validations.routes.js'
import { registerDocumentRoutes } from './modules/documents/documents.routes.js'
import { makeDocumentIntelligenceClient } from './services/document-intelligence-client.js'
import { registerWebhookRoutes } from './modules/webhooks/webhooks.routes.js'
import { registerDebugNf3eQrCodeRoute } from './modules/debug/nf3e-qrcode.js'
import { registerMeRoute } from './modules/me/me.route.js'
import { requireWriteScope } from './plugins/scope.js'
import { docHmacKeyFromPepper, type FastPathDeps } from './services/fastpath.js'
import { makeSigningKeyProvider } from './services/signing-key-provider.factory.js'
import { readPolicyFile } from './policy-loader.js'

export const buildFastPathDeps = (
  db: Db,
  config: AppConfig,
  cache?: ReturnType<typeof makeRedisCache>,
): FastPathDeps => {
  const cached = cache !== undefined ? makeCachedReaders(db, cache) : null
  const registry = cached?.registry ?? makeRegistryReader(db)
  const cep = cached?.cep ?? makeCepReader(db)
  const { policy, policyHash } = readPolicyFile(config.POLICY_VERSION)
  return {
    db,
    registry,
    cep,
    checkers: makeT0Checkers({
      registry,
      cnefe: cached?.cnefe ?? makeCnefeReader(db),
      cep,
      profile: cached?.profile ?? makeProfileReader(db),
      knownShared: cached?.knownShared ?? makeKnownSharedReader(db),
      cnaeCategoria: cached?.cnaeCategoria ?? makeCnaeCategoriaReader(db),
    }),
    policy,
    policyHash,
    clock: systemClock,
    docHmacKey: docHmacKeyFromPepper(config.API_KEY_PEPPER),
  }
}

export interface AppDeps {
  readonly config: AppConfig
  readonly db: Db
  readonly redis: Redis
  readonly logger: Logger
  readonly metrics: Metrics
  /**
   * ObjectStore privado do intake. Testes injetam um fake; em produção o
   * `server.ts`/config resolve S3. Sem store configurado a rota falha fechado
   * com 503, nunca grava em memória silenciosamente.
   */
  readonly objectStore?: ObjectStore
}

const resolveObjectStore = (config: AppConfig): ObjectStore =>
  config.S3_ENDPOINT !== undefined &&
  config.S3_ACCESS_KEY_ID !== undefined &&
  config.S3_SECRET_ACCESS_KEY !== undefined &&
  config.S3_BUCKET !== undefined
    ? makeS3ObjectStore({
        endpoint: config.S3_ENDPOINT,
        region: config.S3_REGION ?? 'us-east-1',
        bucket: config.S3_BUCKET,
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      })
    : makeUnavailableObjectStore()

export const buildApp = async (deps: AppDeps): Promise<FastifyInstance> => {
  const app: FastifyInstance = Fastify({
    logger: false,
    genReqId: () => randomUUID(),
  }).withTypeProvider<ZodTypeProvider>()

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  const evidenceMaxBytes = deps.config.EVIDENCE_MAX_BYTES ?? EVIDENCE_ARTIFACT_MAX_BYTES
  const evidenceMaxConcurrency = deps.config.EVIDENCE_MAX_CONCURRENCY ?? DEFAULT_EVIDENCE_MAX_CONCURRENCY
  const documentIntelligenceTimeoutMs = deps.config.DOCUMENT_INTELLIGENCE_TIMEOUT_MS ?? 300_000
  const documentIntelligenceMaxFileSizeMb = deps.config.DOCUMENT_INTELLIGENCE_MAX_FILE_SIZE_MB ?? 30
  const documentIntelligence = makeDocumentIntelligenceClient({
    url: deps.config.DOCUMENT_INTELLIGENCE_URL,
    timeoutMs: documentIntelligenceTimeoutMs,
    maxFileSizeMb: documentIntelligenceMaxFileSizeMb,
    logger: deps.logger,
  })
  const documentIntelligenceMaxBytes = documentIntelligenceMaxFileSizeMb * 1024 * 1024

  await app.register(helmet)
  await app.register(cors, { origin: true, credentials: true })
  await app.register(multipart, {
    limits: { fileSize: evidenceMaxBytes, files: 1, fields: 0, parts: 1 },
    throwFileSizeLimit: true,
  })
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

  const hasher = makeApiKeyHasher(deps.config.API_KEY_PEPPER)
  const authenticate = makeAuthenticate(deps.db, hasher)
  const rateLimit = makeRateLimiter(deps.redis)

  // Provider de assinatura por tenant resolvido no boot. `local` (default)
  // lê `CREDENTIAL_SIGNING_KEYS` e mantém a privada só em memória; `aws-kms`
  // envia os bytes ao KMS e nunca recebe a privada (ADR-0032). Em ambos, a
  // pública publicada é a fonte da verdade e não há chave global de reserva
  // (ADR-0026). JSON/PEM inválidos derrubam a API antes de aceitar tráfego.
  const signingKeyProvider = await makeSigningKeyProvider(deps.config)

  const cache = makeRedisCache(deps.redis, deps.logger)
  const fastPath = buildFastPathDeps(deps.db, deps.config, cache)
  const objectStore = deps.objectStore ?? resolveObjectStore(deps.config)
  const credentialIssuer = {
    issuerOrigin: deps.config.CREDENTIAL_ISSUER_ORIGIN,
    signingKeyProvider,
    credentialTtlSeconds: fastPath.policy.credential_ttl_seconds,
  }
  const auth = createAuth(deps.db, process.env.BETTER_AUTH_SECRET ?? deps.config.API_KEY_PEPPER)
  registerAuthRoutes(app, auth)
  app.addHook('preHandler', makeSessionMiddleware(auth))
  const deepTrigger = {
    config: {
      enabled: deps.config.TEMPORAL_ENABLED,
      address: deps.config.TEMPORAL_ADDRESS,
      namespace: deps.config.TEMPORAL_NAMESPACE,
      taskQueue: deps.config.TEMPORAL_TASK_QUEUE,
    },
    logger: deps.logger,
  }

  await app.register(
    async (v1) => {
      v1.addHook('preHandler', authenticate)
      v1.addHook('preHandler', rateLimit)
      registerValidationRoutes(v1, {
        db: deps.db,
        fastPath,
        deepTrigger,
        vlmEnabled: deps.config.VLM_ENABLED,
        credentialIssuer,
        objectStore,
        evidenceMaxBytes,
        evidenceMaxConcurrency,
        logger: deps.logger,
      })
      registerDebugNf3eQrCodeRoute(v1, requireWriteScope)
      registerDocumentRoutes(v1, {
        client: documentIntelligence,
        maxBytes: documentIntelligenceMaxBytes,
        logger: deps.logger,
      })
      registerMeRoute(v1, requireWriteScope)
      registerCredentialRoutes(v1, { db: deps.db })
      registerSigningKeyRoutes(v1, { db: deps.db })
      registerWebhookRoutes(v1, { db: deps.db, pepper: deps.config.API_KEY_PEPPER })
      registerBatchRoutes(v1, { db: deps.db })
      registerStatsRoutes(v1, { db: deps.db })
      registerMetaRoutes(v1, { db: deps.db, cache })
      registerSubjectRoutes(v1, { db: deps.db })
    },
    { prefix: '/v1' },
  )

  app.get('/openapi.json', async () => app.swagger())

  // Endpoint para o frontend saber o role do usuário logado (apenas cookie de sessão, sem API key).
  app.get('/api/me', async (request, reply) => {
    const sessionUser = request.sessionUser
    if (sessionUser === undefined) {
      return reply.code(401).send({ error: 'não autenticado' })
    }
    return reply.send({
      id: sessionUser.id,
      email: sessionUser.email,
      name: sessionUser.name,
      role: sessionUser.role,
    })
  })

  registerIssuerRoutes(app, {
    db: deps.db,
    issuerOrigin: deps.config.CREDENTIAL_ISSUER_ORIGIN,
  })
  registerHealthRoutes(app, { db: deps.db, redis: deps.redis })
  registerMetricsRoute(app, deps.metrics)

  return app
}
