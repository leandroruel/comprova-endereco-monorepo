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
const verifiedPrefixes = new Map<string, { readonly expiresAt: number; readonly ctx: TenantContext }>()

/**
 * Chave Redis para rastrear chaves de API revogadas em instâncias distribuídas.
 * Formato: `comprova:revoked_api_keys:<apiKeyId>` com TTL igual ao CACHE_TTL_MS.
 */
const revokedKeyCacheKey = (apiKeyId: string): string => `comprova:revoked_api_keys:${apiKeyId}`

let redisClient: Redis | null = null

export const setRedisClient = (redis: Redis): void => {
  redisClient = redis
}

const isRevokedInCache = async (apiKeyId: string): Promise<boolean> => {
  if (!redisClient) {
    // Não há como verificar o estado de revogação sem Redis: falha fechada
    // para evitar que uma chave revogada continue sendo aceita.
    throw new Error('revocation check unavailable: redis client not configured')
  }
  try {
    const result = await redisClient.get(revokedKeyCacheKey(apiKeyId))
    return result === '1'
  } catch (error) {
    // Falha ao consultar Redis: falha fechada para não aceitar chaves
    // potencialmente revogadas.
    throw new Error(`revocation check unavailable: ${error instanceof Error ? error.message : String(error)}`)
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

const cacheGet = (prefixHash: string, now: number): TenantContext | null => {
  const hit = verifiedPrefixes.get(prefixHash)
  if (hit === undefined) return null
  if (hit.expiresAt < now) {
    verifiedPrefixes.delete(prefixHash)
    return null
  }
  // Re-chave expirou: invalida a entrada do cache mesmo antes do TTL.
  if (
    hit.ctx.expiresAt !== null &&
    hit.ctx.expiresAt !== undefined &&
    new Date(hit.ctx.expiresAt) < new Date()
  ) {
    verifiedPrefixes.delete(prefixHash)
    return null
  }
  return hit.ctx
}

const cachePut = (prefixHash: string, ctx: TenantContext, now: number): void => {
  if (verifiedPrefixes.size >= CACHE_MAX) {
    const oldest = verifiedPrefixes.keys().next().value
    if (oldest !== undefined) verifiedPrefixes.delete(oldest)
  }
  verifiedPrefixes.set(prefixHash, { expiresAt: now + CACHE_TTL_MS, ctx })
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
      // Falha fechada: se não for possível verificar, rejeita a autenticação.
      let revoked = false
      try {
        revoked = await isRevokedInCache(cached.apiKeyId)
      } catch {
        cacheInvalidate(prefixHash)
        return unauthorized(reply)
      }
      if (revoked) {
        cacheInvalidate(prefixHash)
        return unauthorized(reply)
      }
      request.tenant = cached
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
    // Isso impede que uma chave persistida com estado inconsistente (ex.: chave
    // 'user' com scope 'verify:m2m') seja aceita em autenticação.
    const keyType = match.keyType as 'user' | 'm2m' | string
    if (keyType !== 'user' && keyType !== 'm2m') {
      // Tipo de chave desconhecido ou inválido: rejeita.
      return unauthorized(reply)
    }
    try {
      validateScopesForKeyType(keyType, match.scopes)
    } catch {
      return unauthorized(reply)
    }

    // Rejeita chaves expiradas.
    if (match.expiresAt !== null && match.expiresAt !== undefined && new Date(match.expiresAt) < new Date()) {
      return unauthorized(reply)
    }

    const ctx: TenantContext = {
      tenantId: match.tenantId,
      apiKeyId: match.apiKeyId,
      scopes: match.scopes,
      rateLimitRps: match.rateLimitRps,
      burst: match.burst,
      expiresAt: match.expiresAt,
      keyType: keyType,
    }
    cachePut(prefixHash, ctx, now)
    request.tenant = ctx
  }
}

export { markRevokedInCache }
