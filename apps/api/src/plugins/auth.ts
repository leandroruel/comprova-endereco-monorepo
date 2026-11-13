import { PROBLEM_CONTENT_TYPE, problems } from '@comprova/contracts'
import { and, eq, isNull, keyPrefixOf, type Db, type ApiKeyHasher } from '@comprova/db'
import * as t from '@comprova/db'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { ALL_API_SCOPES, validateScopesForKeyType } from './scope.js'

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

const cacheGet = (prefixHash: string, now: number): { readonly ctx: TenantContext } | null => {
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
  return { ctx: hit.ctx }
}

const cachePut = (prefixHash: string, ctx: TenantContext, now: number): void => {
  if (verifiedPrefixes.size >= CACHE_MAX) {
    const oldest = verifiedPrefixes.keys().next().value
    if (oldest !== undefined) verifiedPrefixes.delete(oldest)
  }
  verifiedPrefixes.set(prefixHash, { expiresAt: now + CACHE_TTL_MS, ctx })
}

/**
 * Invalida entradas de cache local para uma apiKeyId. Percorre o cache em
 * busca da entrada cujo contexto corresponda ao apiKeyId informado.
 * Usado na revogação para garantir que a chave revogada não seja mais
 * aceita pelo cache local desta instância.
 */
export const cacheInvalidate = (apiKeyId: string): void => {
  for (const [prefixHash, entry] of verifiedPrefixes.entries()) {
    if (entry.ctx.apiKeyId === apiKeyId) {
      verifiedPrefixes.delete(prefixHash)
    }
  }
}

/**
 * Verifica se a chave foi revogada consultando diretamente o banco de dados.
 * PostgreSQL é sempre a fonte de verdade sobre o estado de revogação.
 * Nunca confia apenas em cache local ou em marcadores Redis.
 */
const isRevokedInDb = async (db: Db, apiKeyId: string): Promise<boolean> => {
  const rows = await db
    .select({ revokedAt: t.apiKey.revokedAt })
    .from(t.apiKey)
    .where(eq(t.apiKey.apiKeyId, apiKeyId))
    .limit(1)
  return rows.length > 0 && rows[0]!.revokedAt !== null
}

export const makeAuthenticate = (db: Db, hasher: ApiKeyHasher) => {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const header = request.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined
    if (bearer === undefined || bearer.length === 0) {
      // Sem bearer token: permite o request prosseguir. Cada rota específica
      // é responsável por seu próprio guard de autenticação
      // (requireSessionUser para sessão, requireScope para API key).
      return
    }
    const prefix = keyPrefixOf(bearer)
    const prefixHash = hasher.hash(prefix).toString('hex')
    const now = Date.now()
    const cached = cacheGet(prefixHash, now)
    if (cached !== null) {
      // Sempre verifica o estado de revogação no PostgreSQL (fonte de
      // verdade). Nunca confia apenas no cache local, mesmo que ele ainda
      // não tenha expirado. Isso garante que uma chave revogada nunca seja
      // aceita, independentemente do estado do Redis.
      const revoked = await isRevokedInDb(db, cached.ctx.apiKeyId)
      if (revoked) {
        cacheInvalidate(cached.ctx.apiKeyId)
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
