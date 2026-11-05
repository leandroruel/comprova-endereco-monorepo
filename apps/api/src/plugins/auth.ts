import { PROBLEM_CONTENT_TYPE, problems } from '@comprova/contracts'
import type { Db } from '@comprova/db'
import { and, eq, isNull } from '@comprova/db'
import * as t from '@comprova/db'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { keyPrefixOf, type ApiKeyHasher } from '@comprova/db'
import { ALL_API_SCOPES, validateScopesForKeyType } from './scope.js'
import type { Redis } from 'ioredis'

export interface TenantContext {
  readonly tenantId: string
  readonly apiKeyId: string
  readonly scopes: readonly string[]
  readonly rateLimitRps: number
  readonly burst: number
  readonly expiresAt: Date | null
  readonly keyType: 'user' | 'm2m'
}

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: TenantContext
  }
}

interface ApiKeyRow {
  readonly apiKeyId: string
  readonly tenantId: string
  readonly scopes: string[]
  readonly keyHash: Buffer
  readonly status: string
  readonly rateLimitRps: number
  readonly burst: number
  readonly expiresAt: Date | null
  readonly keyType: string
}

const unauthorized = (reply: FastifyReply): FastifyReply =>
  reply.code(401).type(PROBLEM_CONTENT_TYPE).send(problems.unauthorized())

const CACHE_TTL_MS = 60_000
const CACHE_MAX = 5_000
const verifiedPrefixes = new Map<
  string,
  { readonly expiresAt: number; readonly revocationVersion: number; readonly ctx: TenantContext }
>()

/**
 * Chave Redis para rastrear chaves de API revogadas em instâncias distribuídas.
 * Formato: `comprova:revoked_api_keys:<apiKeyId>` com TTL igual ao CACHE_TTL_MS.
 */
const revokedKeyCacheKey = (apiKeyId: string): string => `comprova:revoked_api_keys:${apiKeyId}`

/**
 * Versão global de revogação. Incrementada a cada revogação bem-sucedida.
 * Usada para detectar entradas de cache locais que podem estar desatualizadas
 * após uma revogação ocorrida enquanto o Redis estava indisponível.
 */
const revocationVersionKey = 'comprova:auth_revocation_version'

let redisClient: Redis | null = null

export const setRedisClient = (redis: Redis): void => {
  redisClient = redis
  // Quando o Redis se reconecta após uma indisponibilidade, incrementa a
  // versão de revogação para forçar a re-validação de todas as entradas de
  // cache locais contra o banco de dados (fonte confiável).
  redis.on('reconnect', async () => {
    try {
      await incrementRevocationVersion()
    } catch {
      // Best effort: se falhar, as instâncias ainda verificarão o DB no próximo cache hit.
    }
  })
}

const isRevokedInCache = async (apiKeyId: string): Promise<boolean> => {
  if (!redisClient) {
    throw new Error('revocation check unavailable: redis client not configured')
  }
  try {
    const result = await redisClient.get(revokedKeyCacheKey(apiKeyId))
    return result === '1'
  } catch (error) {
    throw new Error(`revocation check unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Verifica se a chave foi revogada consultando diretamente o banco de dados.
 * Usado como fallback quando Redis está indisponível durante a autenticação
 * por cache local, garantindo que uma chave revogada no banco nunca seja
 * aceita mesmo após recuperação do Redis.
 */
const isRevokedInDb = async (db: Db, apiKeyId: string): Promise<boolean> => {
  const rows = await db
    .select({ revokedAt: t.apiKey.revokedAt })
    .from(t.apiKey)
    .where(eq(t.apiKey.apiKeyId, apiKeyId))
    .limit(1)
  return rows.length > 0 && rows[0]!.revokedAt !== null
}

const getRevocationVersion = async (): Promise<number> => {
  if (!redisClient) {
    throw new Error('revocation version unavailable: redis client not configured')
  }
  try {
    const v = await redisClient.get(revocationVersionKey)
    return v ? parseInt(v, 10) : 0
  } catch (error) {
    throw new Error(
      `revocation version unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const incrementRevocationVersion = async (): Promise<void> => {
  if (!redisClient) {
    throw new Error('revocation version unavailable: redis client not configured')
  }
  try {
    await redisClient.incr(revocationVersionKey)
  } catch (error) {
    throw new Error(
      `revocation version increment failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const markRevokedInCache = async (apiKeyId: string): Promise<void> => {
  if (!redisClient) {
    throw new Error('revocation cache unavailable: redis client not configured')
  }
  try {
    await redisClient.set(revokedKeyCacheKey(apiKeyId), '1', 'EX', Math.ceil(CACHE_TTL_MS / 1000))
  } catch (error) {
    throw new Error(`revocation cache unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const cacheGet = (
  prefixHash: string,
  now: number,
): { revocationVersion: number; ctx: TenantContext } | null => {
  const hit = verifiedPrefixes.get(prefixHash)
  if (hit === undefined) return null
  if (hit.expiresAt < now) {
    verifiedPrefixes.delete(prefixHash)
    return null
  }
  if (hit.ctx.expiresAt !== null && new Date(hit.ctx.expiresAt) < new Date()) {
    verifiedPrefixes.delete(prefixHash)
    return null
  }
  return { revocationVersion: hit.revocationVersion, ctx: hit.ctx }
}

const cachePut = (prefixHash: string, ctx: TenantContext, now: number, revocationVersion: number): void => {
  if (verifiedPrefixes.size >= CACHE_MAX) {
    const oldest = verifiedPrefixes.keys().next().value
    if (oldest !== undefined) verifiedPrefixes.delete(oldest)
  }
  verifiedPrefixes.set(prefixHash, { expiresAt: now + CACHE_TTL_MS, revocationVersion, ctx })
}

const cacheInvalidate = (prefixHash: string): void => {
  verifiedPrefixes.delete(prefixHash)
}

export const makeAuthenticate = (db: Db, hasher: ApiKeyHasher) => {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    // Se há uma sessão de usuário válida (definida por makeSessionMiddleware),
    // permite o acesso por sessão (ex.: dashboard do Verifier). Isso não reusa
    // o token de sessão como credencial de API: é um contexto de autenticação
    // distinto, verificado pelo cookie de sessão do Better Auth.
    if (request.sessionUser !== undefined) {
      return
    }

    const header = request.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined
    if (bearer === undefined || bearer.length === 0) {
      // Sem bearer token e sem sessão: permite o request prosseguir.
      // Cada rota específica é responsável por seu próprio guard de
      // autenticação (requireSessionUser para sessão, requireScope para API key).
      return
    }
    const prefix = keyPrefixOf(bearer)
    const prefixHash = hasher.hash(prefix).toString('hex')
    const now = Date.now()
    const cached = cacheGet(prefixHash, now)
    if (cached !== null) {
      // Verifica se a chave foi revogada no cache distribuído (Redis).
      // Falha fechada: se não for possível verificar via Redis, consulta o
      // banco diretamente. Se a versão de revogação do cache for menor que a
      // versão atual no Redis, re-valida contra o banco (a chave pode ter sido
      // revogada enquanto o Redis estava indisponível).
      let currentVersion: number
      try {
        currentVersion = await getRevocationVersion()
      } catch {
        // Redis indisponível: verifica a fonte confiável (banco de dados).
        const revoked = await isRevokedInDb(db, cached.ctx.apiKeyId)
        if (revoked) {
          cacheInvalidate(prefixHash)
          return unauthorized(reply)
        }
        request.tenant = cached.ctx
        return
      }

      if (cached.revocationVersion < currentVersion) {
        // Versão desatualizada: a chave pode ter sido revogada enquanto este
        // cache foi armazenado. Re-valida contra o banco de dados.
        const revoked = await isRevokedInDb(db, cached.ctx.apiKeyId)
        if (revoked) {
          cacheInvalidate(prefixHash)
          return unauthorized(reply)
        }
        // Atualiza o cache com a versão atual e prossegue.
        cachePut(prefixHash, cached.ctx, now, currentVersion)
        request.tenant = cached.ctx
        return
      }

      // Versão corresponde: verifica marcador rápido no Redis.
      let revoked = false
      try {
        revoked = await isRevokedInCache(cached.ctx.apiKeyId)
      } catch {
        const dbRevoked = await isRevokedInDb(db, cached.ctx.apiKeyId)
        if (dbRevoked) {
          cacheInvalidate(prefixHash)
          return unauthorized(reply)
        }
        request.tenant = cached.ctx
        return
      }
      if (revoked) {
        cacheInvalidate(prefixHash)
        return unauthorized(reply)
      }
      request.tenant = cached.ctx
      return
    }

    const rows = (await db
      .select({
        apiKeyId: t.apiKey.apiKeyId,
        tenantId: t.apiKey.tenantId,
        scopes: t.apiKey.scopes,
        keyHash: t.apiKey.keyHash,
        status: t.tenant.status,
        rateLimitRps: t.tenant.rateLimitRps,
        burst: t.tenant.burst,
        expiresAt: t.apiKey.expiresAt,
        keyType: t.apiKey.keyType,
      })
      .from(t.apiKey)
      .innerJoin(t.tenant, eq(t.apiKey.tenantId, t.tenant.tenantId))
      .where(and(eq(t.apiKey.keyPrefix, prefix), isNull(t.apiKey.revokedAt)))) as readonly ApiKeyRow[]

    const match = rows.find((row) => hasher.verify(row.keyHash, bearer))
    if (match === undefined || match.status !== 'active') {
      return unauthorized(reply)
    }

    // Rejeita chaves com escopos desconhecidos (defesa em profundidade: nunca
    // confia em valores persistidos direto no banco).
    for (const scope of match.scopes) {
      if (!ALL_API_SCOPES.includes(scope)) {
        return unauthorized(reply)
      }
    }

    // Valida que os scopes persistidos são compatíveis com o tipo da chave.
    const keyType = match.keyType as 'user' | 'm2m' | string
    if (keyType !== 'user' && keyType !== 'm2m') {
      return unauthorized(reply)
    }
    try {
      validateScopesForKeyType(keyType, match.scopes)
    } catch {
      return unauthorized(reply)
    }

    // Rejeita chaves expiradas.
    if (match.expiresAt !== null && new Date(match.expiresAt) < new Date()) {
      return unauthorized(reply)
    }

    const currentVersion = await getRevocationVersion()
    const ctx: TenantContext = {
      tenantId: match.tenantId,
      apiKeyId: match.apiKeyId,
      scopes: match.scopes,
      rateLimitRps: match.rateLimitRps,
      burst: match.burst,
      expiresAt: match.expiresAt,
      keyType: keyType,
    }
    cachePut(prefixHash, ctx, now, currentVersion)
    request.tenant = ctx
  }
}

export { markRevokedInCache, cacheInvalidate, incrementRevocationVersion }
