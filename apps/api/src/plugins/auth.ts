import { PROBLEM_CONTENT_TYPE, problems } from '@comprova/contracts'
import type { Db } from '@comprova/db'
import { and, eq, isNull } from '@comprova/db'
import * as t from '@comprova/db'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { keyPrefixOf, type ApiKeyHasher } from '../shared/api-keys.js'

export interface TenantContext {
  readonly tenantId: string
  readonly apiKeyId: string
  readonly scopes: readonly string[]
  readonly rateLimitRps: number
  readonly burst: number
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
}

const unauthorized = (reply: FastifyReply): FastifyReply =>
  reply.code(401).type(PROBLEM_CONTENT_TYPE).send(problems.unauthorized())

const CACHE_TTL_MS = 60_000
const CACHE_MAX = 5_000
const verifiedPrefixes = new Map<string, { readonly expiresAt: number; readonly ctx: TenantContext }>()

const cacheGet = (prefixHash: string, now: number): TenantContext | null => {
  const hit = verifiedPrefixes.get(prefixHash)
  if (hit === undefined) return null
  if (hit.expiresAt < now) {
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

export const makeAuthenticate = (db: Db, hasher: ApiKeyHasher) => {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const header = request.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined
    if (bearer === undefined || bearer.length === 0) {
      return unauthorized(reply)
    }
    const prefix = keyPrefixOf(bearer)
    const prefixHash = hasher.hash(prefix).toString('hex')
    const now = Date.now()
    const cached = cacheGet(prefixHash, now)
    if (cached !== null) {
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
      })
      .from(t.apiKey)
      .innerJoin(t.tenant, eq(t.apiKey.tenantId, t.tenant.tenantId))
      .where(and(eq(t.apiKey.keyPrefix, prefix), isNull(t.apiKey.revokedAt)))) as readonly ApiKeyRow[]

    const match = rows.find((row) => hasher.verify(row.keyHash, bearer))
    if (match === undefined || match.status !== 'active') {
      return unauthorized(reply)
    }

    const ctx: TenantContext = {
      tenantId: match.tenantId,
      apiKeyId: match.apiKeyId,
      scopes: match.scopes,
      rateLimitRps: match.rateLimitRps,
      burst: match.burst,
    }
    cachePut(prefixHash, ctx, now)
    request.tenant = ctx
  }
}
