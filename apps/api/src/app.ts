import { createHash, randomUUID } from 'node:crypto'
import { PROBLEM_CONTENT_TYPE, problem } from '@comprova/contracts'
import { makeT0Checkers } from '@comprova/checkers'
import { systemClock } from '@comprova/core'
import { type Logger, type Metrics } from '@comprova/observability'
import {
  EVIDENCE_ARTIFACT_MAX_BYTES,
  makeApiKeyHasher,
  makeCachedReaders,
  makeCepReader,
  makeCnaeCategoriaReader,
  makeCnefeReader,
  makeKnownSharedReader,
  makeProfileReader,
  makeRedisCache,
  makeRegistryReader,
  QuotaExceededError,
  type Db,
} from '@comprova/db'
import {
  makeDocumentIntelligenceClient,
  makeObjectStore,
  type ObjectStore,
  type ObjectStoreProvider,
} from '@comprova/providers'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import swagger from '@fastify/swagger'
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from '@fastify/type-provider-zod'
import type Redis from 'ioredis'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import {
  DEFAULT_ADMIN_ORIGINS,
  DEFAULT_EVIDENCE_MAX_CONCURRENCY,
  DEFAULT_VERIFIER_ORIGINS,
  parseOriginList,
  type AppConfig,
} from './config.js'
import { makeAuthenticate } from './plugins/auth.js'
import { makeRateLimiter } from './plugins/rate-limit.js'
import { createAuthAdmin } from './auth-admin.js'
import { createAuthVerifier } from './auth-verifier.js'
import { registerAuthAdminRoutes } from './routes/auth-admin-routes.js'
import { registerAuthVerifierRoutes } from './routes/auth-verifier-routes.js'
import { makeSessionMiddleware, type AuthInstance } from './plugins/session.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerMetricsRoute } from './routes/metrics.js'
import { registerBatchRoutes } from './modules/batches/batches.routes.js'
import { registerCredentialRoutes } from './modules/credentials/credentials.routes.js'
import { registerIssuerRoutes } from './modules/issuers/issuers.routes.js'
import { registerSigningKeyRoutes } from './modules/signing-keys/signing-keys.routes.js'
import { registerMetaRoutes } from './modules/meta/meta.routes.js'
import { registerStatsRoutes } from './modules/stats/stats.routes.js'
import { registerSubjectRoutes } from './modules/subjects/subjects.routes.js'
import { registerUsageRoutes } from './modules/usage/usage.routes.js'
import { registerValidationRoutes } from './modules/validations/validations.routes.js'
import { registerDocumentRoutes } from './modules/documents/documents.routes.js'
import { registerWebhookRoutes } from './modules/webhooks/webhooks.routes.js'
import { registerBillingRoutes } from './modules/billing/billing.routes.js'
import { registerDebugNf3eQrCodeRoute } from './modules/debug/nf3e-qrcode.js'
import { registerMeRoute } from './modules/me/me.route.js'
import { registerOrganizationsRoutes } from './modules/organizations/organizations.routes.js'
import { registerM2MRoutes } from './modules/m2m/m2m.routes.js'
import { registerHolderRoutes } from './modules/holder/holder.routes.js'
import { registerHolderInformationRequestRoutes } from './modules/holder/holder-information-request.routes.js'
import { registerHolderAccessRoutes } from './modules/holder/holder-access.routes.js'
import { makeHolderSubmissionProcessingService } from './modules/holder/holder-submission-processing.service.js'
import { registerHolderAccessTokenRoutes } from './modules/holder/holder-access-token.routes.js'
import { makeHolderRateLimits } from './plugins/holder-rate-limit.js'
import { AuthorizationError } from './modules/m2m/m2m.service.js'
import { requireWriteScope } from './plugins/scope.js'
import { docHmacKeyFromPepper, type FastPathDeps } from './services/fastpath.js'
import { makeSigningKeyProvider } from './services/signing-key-provider.factory.js'
import { readPolicyFile } from './policy-loader.js'

export const buildFastPathDeps = (
  db: Db,
  config: AppConfig,
  cache?: ReturnType<typeof makeRedisCache>,
  /** Conexão do database de referência (CNEFE/Receita). Ausente = modo single-database. */
  referenceDb?: Db,
): FastPathDeps => {
  const refDb = referenceDb ?? db
  const cached = cache !== undefined ? makeCachedReaders(db, cache, referenceDb) : null
  const registry = cached?.registry ?? makeRegistryReader(refDb)
  const cep = cached?.cep ?? makeCepReader(refDb)
  const { policy, policyHash } = readPolicyFile(config.POLICY_VERSION)
  return {
    db,
    registry,
    cep,
    checkers: makeT0Checkers({
      registry,
      cnefe: cached?.cnefe ?? makeCnefeReader(refDb),
      cep,
      profile: cached?.profile ?? makeProfileReader(db, refDb),
      knownShared: cached?.knownShared ?? makeKnownSharedReader(refDb),
      cnaeCategoria: cached?.cnaeCategoria ?? makeCnaeCategoriaReader(refDb),
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
  /**
   * Conexão do database de referência (CNEFE/Receita). Quando presente, os
   * readers de referência deixam de consultar o `db` operacional. Opcional:
   * ausente, o produto opera no modo single-database (transição).
   */
  readonly referenceDb?: Db
  readonly redis: Redis
  readonly logger: Logger
  readonly metrics: Metrics
  /**
   * ObjectStore privado do intake. Testes injetam um fake; em produção o
   * `server.ts`/config resolve S3. Sem store configurado a rota falha fechado
   * com 503, nunca grava em memória silenciosamente.
   */
  readonly objectStore?: ObjectStore
  /**
   * ProviderRegistry global (billing). Injetado para rotas de billing webhooks.
   * Opcional: testes podem omitir; se ausente, rotas de billing não são registradas.
   */
  readonly providerRegistry?: import('@comprova/billing-core').ProviderRegistry
}

const resolveObjectStore = (config: AppConfig): ObjectStore => {
  const provider: ObjectStoreProvider =
    config.S3_ENDPOINT !== undefined &&
    config.S3_ACCESS_KEY_ID !== undefined &&
    config.S3_SECRET_ACCESS_KEY !== undefined &&
    config.S3_BUCKET !== undefined
      ? 's3'
      : config.SUPABASE_URL !== undefined &&
          config.SUPABASE_SERVICE_ROLE_KEY !== undefined &&
          config.SUPABASE_STORAGE_BUCKET !== undefined
        ? 'supabase'
        : config.LOCAL_STORAGE_PATH !== undefined
          ? 'local'
          : 'unavailable'

  return makeObjectStore({
    provider,
    s3:
      provider === 's3'
        ? {
            endpoint: config.S3_ENDPOINT!,
            region: config.S3_REGION ?? 'us-east-1',
            bucket: config.S3_BUCKET!,
            accessKeyId: config.S3_ACCESS_KEY_ID!,
            secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
          }
        : undefined,
    supabase:
      provider === 'supabase'
        ? {
            supabaseUrl: config.SUPABASE_URL!,
            supabaseServiceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY!,
            bucket: config.SUPABASE_STORAGE_BUCKET!,
          }
        : undefined,
    local:
      provider === 'local'
        ? {
            rootPath: config.LOCAL_STORAGE_PATH!,
          }
        : undefined,
    unavailableReason: 'object storage is not configured',
  })
}

export const buildApp = async (deps: AppDeps): Promise<FastifyInstance> => {
  // O banco de referência é opcional. Quando ausente, o sistema opera em
  // modo single-database (tudo no DATABASE_URL).
  const app: FastifyInstance = Fastify({
    logger: false,
    genReqId: () => randomUUID(),
  }).withTypeProvider<ZodTypeProvider>()

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  const evidenceMaxBytes = deps.config.EVIDENCE_MAX_BYTES ?? EVIDENCE_ARTIFACT_MAX_BYTES
  const evidenceMaxConcurrency = deps.config.EVIDENCE_MAX_CONCURRENCY ?? DEFAULT_EVIDENCE_MAX_CONCURRENCY
  // Deve ser MAIOR que o `DI_TIMEOUT_S` do serviço (default 300 s): assim o
  // 504 estruturado do serviço chega antes do abort do cliente. A primeira
  // inferência de OCR em CPU foi medida em ~294 s; 360 s dá margem para o
  // upload e a transferência da resposta.
  const documentIntelligenceTimeoutMs = deps.config.DOCUMENT_INTELLIGENCE_TIMEOUT_MS ?? 360_000
  const documentIntelligenceMaxFileSizeMb = deps.config.DOCUMENT_INTELLIGENCE_MAX_FILE_SIZE_MB ?? 30
  const documentIntelligence = makeDocumentIntelligenceClient({
    url: deps.config.DOCUMENT_INTELLIGENCE_URL,
    timeoutMs: documentIntelligenceTimeoutMs,
    maxFileSizeMb: documentIntelligenceMaxFileSizeMb,
    logger: deps.logger,
  })
  const documentIntelligenceMaxBytes = documentIntelligenceMaxFileSizeMb * 1024 * 1024

  await app.register(helmet)
  const adminOrigins = parseOriginList(deps.config.DASHBOARD_ADMIN_ORIGINS) ?? DEFAULT_ADMIN_ORIGINS
  const verifierOrigins = parseOriginList(deps.config.DASHBOARD_VERIFIER_ORIGINS) ?? DEFAULT_VERIFIER_ORIGINS
  const allowedOrigins = [...new Set([...adminOrigins, ...verifierOrigins, 'http://localhost:3000'])]

  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'cookie', 'x-holder-token'],
    exposedHeaders: ['set-cookie'],
    preflight: true,
    preflightContinue: false,
  })

  await app.register(cookie, {
    secret: deps.config.API_KEY_PEPPER,
  })

  // Fallback de CORS no onResponse: garante que os cabeçalhos CORS estejam
  // sempre presentes, mesmo quando o plugin @fastify/cors não os aplica (ex.:
  // respostas de erro, 404, 500, ou qualquer comportamento inesperado do
  // plugin). Isso evita que o navegador bloqueie a requisição por falta do
  // cabeçalho Access-Control-Allow-Origin.
  app.addHook('onResponse', (request, reply) => {
    const origin = (request.headers as Record<string, string | undefined>)['origin']
    if (!origin) return
    if (!allowedOrigins.includes(origin)) return
    // Se o plugin já definiu o cabeçalho, não sobrescreve.
    if (reply.getHeader('access-control-allow-origin')) return
    reply.header('access-control-allow-origin', origin)
    reply.header('access-control-allow-credentials', 'true')
    reply.header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    reply.header('access-control-allow-headers', 'content-type, authorization, cookie, x-holder-token')
    reply.header('access-control-expose-headers', 'set-cookie')
    reply.header('vary', 'Origin')
  })
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

  /**
   * O erro do drizzle (`DrizzleQueryError`) só carrega a query e os params na
   * mensagem; código SQLSTATE, constraint e detalhe do Postgres ficam em
   * `cause`. Sem isso o log de um 500 é apenas "Failed query" e não permite
   * saber qual constraint foi violada. `redactDeep` (logger) descarta campos
   * não enumeráveis de `Error`, então montamos um objeto plano.
   */
  const errorCauseDetails = (error: unknown): Record<string, unknown> | undefined => {
    if (!(error instanceof Error)) return undefined
    const cause = error.cause
    if (cause === undefined || cause === null) return undefined
    if (!(cause instanceof Error)) return { message: String(cause) }
    const pg = cause as Error & {
      readonly code?: unknown
      readonly severity?: unknown
      readonly detail?: unknown
      readonly constraint?: unknown
      readonly table?: unknown
      readonly column?: unknown
    }
    const details: Record<string, unknown> = {
      type: cause.constructor.name,
      message: cause.message,
      stack: cause.stack,
    }
    for (const field of ['code', 'severity', 'detail', 'constraint', 'table', 'column'] as const) {
      if (pg[field] !== undefined) details[field] = pg[field]
    }
    return details
  }

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
    if (err instanceof AuthorizationError) {
      reply
        .code(403)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problem(403, 'FORBIDDEN', err.message))
      return
    }
    if (err instanceof QuotaExceededError) {
      reply
        .code(429)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problem(429, 'QUOTA_EXCEEDED', err.message))
      return
    }
    deps.logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        error_type: err instanceof Error ? err.constructor.name : typeof err,
        error_stack: err instanceof Error ? err.stack : undefined,
        error_cause: errorCauseDetails(err),
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
  const holderRateLimits = makeHolderRateLimits(deps.redis, deps.logger)

  // Provider de assinatura por tenant resolvido no boot. `local` (default)
  // lê `CREDENTIAL_SIGNING_KEYS` e mantém a privada só em memória; `aws-kms`
  // envia os bytes ao KMS e nunca recebe a privada (ADR-0032). Em ambos, a
  // pública publicada é a fonte da verdade e não há chave global de reserva
  // (ADR-0026). JSON/PEM inválidos derrubam a API antes de aceitar tráfego.
  const signingKeyProvider = await makeSigningKeyProvider(deps.config)

  const cache = makeRedisCache(deps.redis, deps.logger)
  const fastPath = buildFastPathDeps(deps.db, deps.config, cache, deps.referenceDb)
  const objectStore = deps.objectStore ?? resolveObjectStore(deps.config)
  const credentialIssuer = {
    issuerOrigin: deps.config.CREDENTIAL_ISSUER_ORIGIN,
    signingKeyProvider,
    credentialTtlSeconds: fastPath.policy.credential_ttl_seconds,
  }
  // Instâncias separadas do Better Auth para admin e verifier, com tabelas
  // de auth distintas (isolamento total de sessões entre os dashboards).
  const authAdmin = createAuthAdmin(
    deps.db,
    process.env.BETTER_AUTH_SECRET ?? deps.config.API_KEY_PEPPER,
    adminOrigins,
  )
  const authVerifier = createAuthVerifier(
    deps.db,
    process.env.BETTER_AUTH_SECRET ?? deps.config.API_KEY_PEPPER,
    verifierOrigins,
  )
  registerAuthAdminRoutes(app, authAdmin)
  registerAuthVerifierRoutes(app, authVerifier)

  app.addHook(
    'preHandler',
    makeSessionMiddleware({
      admin: authAdmin as unknown as AuthInstance,
      verifier: authVerifier as unknown as AuthInstance,
      adminOrigins,
      verifierOrigins,
    }),
  )
  app.addHook('preHandler', authenticate)

  await app.register(
    async (v1) => {
      v1.addHook('preHandler', rateLimit)
      registerValidationRoutes(v1, {
        db: deps.db,
        fastPath,
        credentialIssuer,
        objectStore,
        evidenceMaxBytes,
        evidenceMaxConcurrency,
        logger: deps.logger,
      })
      registerDebugNf3eQrCodeRoute(v1, requireWriteScope, {
        // O debugger reflete o pipeline real: o mesmo cliente do Document
        // Intelligence (Marker) usado pela rota /documents/parse. Desabilitado
        // quando a URL não está configurada.
        documentIntelligence: documentIntelligence.enabled ? documentIntelligence : null,
      })
      registerDocumentRoutes(v1, {
        client: documentIntelligence,
        maxBytes: documentIntelligenceMaxBytes,
        logger: deps.logger,
      })
      registerMeRoute(v1, requireWriteScope)
      // TERMS_VERSION é opcional no boot: a validação da versão ocorre apenas
      // quando o fluxo de onboarding é acessado. Sem ela, o endpoint de
      // onboarding retorna erro, mas o restante da API segue funcional.
      const termsVersion = deps.config.TERMS_VERSION ?? null
      const termsApproved = deps.config.TERMS_APPROVED === 'true'
      const termsDocumentHash = deps.config.TERMS_DOCUMENT_HASH ?? null
      const termsDocumentContent = deps.config.TERMS_DOCUMENT_CONTENT ?? null

      // Calcula o SHA-256 do conteúdo dos termos e compara com o hash
      // configurado. A integridade é revalidada no momento do aceite para
      // evitar que conteúdo alterado seja aceito sem o hash correspondente.
      let termsHashValid = false
      if (
        termsDocumentContent !== null &&
        termsDocumentContent.trim().length > 0 &&
        termsDocumentHash !== null &&
        termsDocumentHash.trim().length > 0
      ) {
        const calculatedHash = createHash('sha256').update(termsDocumentContent, 'utf8').digest('hex')
        // Remove o prefixo "sha256:" do hash configurado, se presente, para
        // permitir comparação direta com o hash calculado.
        const configuredHash = termsDocumentHash.replace(/^sha256:/i, '')
        termsHashValid = calculatedHash === configuredHash
      }

      registerOrganizationsRoutes(v1, {
        db: deps.db,
        termsVersion,
        termsApproved,
        termsDocumentHash,
      })
      registerM2MRoutes(v1, { db: deps.db, apiKeyPepper: deps.config.API_KEY_PEPPER })
      registerHolderRoutes(v1, { db: deps.db })
      registerHolderInformationRequestRoutes(v1, {
        db: deps.db,
        pepper: deps.config.API_KEY_PEPPER,
        logger: deps.logger,
      })
      registerHolderAccessTokenRoutes(v1, {
        db: deps.db,
        pepper: deps.config.API_KEY_PEPPER,
        logger: deps.logger,
      })
      registerHolderAccessRoutes(
        v1,
        {
          db: deps.db,
          store: objectStore,
          pepper: deps.config.API_KEY_PEPPER,
          logger: deps.logger,
          metrics: deps.metrics,
          maxDocumentBytes: evidenceMaxBytes,
          terms: {
            version: termsVersion,
            approved: termsApproved,
            documentHash: termsDocumentHash,
            content: termsDocumentContent,
            hashValid: termsHashValid,
          },
          processingService: makeHolderSubmissionProcessingService({
            db: deps.db,
            store: objectStore,
            logger: deps.logger,
          }),
        },
        holderRateLimits,
      )
      registerCredentialRoutes(v1, { db: deps.db })
      registerSigningKeyRoutes(v1, { db: deps.db })
      registerWebhookRoutes(v1, { db: deps.db, pepper: deps.config.API_KEY_PEPPER })
      if (deps.providerRegistry) {
        registerBillingRoutes(v1, { db: deps.db, providerRegistry: deps.providerRegistry })
      }
      registerBatchRoutes(v1, { db: deps.db })
      registerStatsRoutes(v1, { db: deps.db })
      registerUsageRoutes(v1, { db: deps.db })
      registerMetaRoutes(v1, { db: deps.db, cache, referenceDb: deps.referenceDb })
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
