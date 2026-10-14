import { verify } from '@node-rs/argon2'
import { PROBLEM_CONTENT_TYPE, problems } from '@comprova/contracts'
import { findFirstAsync } from '@comprova/core'
import { and, eq, isNull, type Db } from '@comprova/db'
import * as t from '@comprova/db'
import type { FastifyReply, FastifyRequest } from 'fastify'

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
const verifiedKeys = new Map<string, { readonly expiresAt: number; readonly ctx: TenantContext }>()

const cacheGet = (bearer: string, now: number): TenantContext | null => {
  const hit = verifiedKeys.get(bearer)
  if (hit === undefined) return null
  if (hit.expiresAt < now) {
    verifiedKeys.delete(bearer)
    return null
  }
  return hit.ctx
}

const cachePut = (bearer: string, ctx: TenantContext, now: number): void => {
  if (verifiedKeys.size >= CACHE_MAX) {
    const oldest = verifiedKeys.keys().next().value
    if (oldest !== undefined) verifiedKeys.delete(oldest)
  }
  verifiedKeys.set(bearer, { expiresAt: now + CACHE_TTL_MS, ctx })
}

export const makeAuthenticate = (db: Db, pepper: string) => {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const header = request.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined
    if (bearer === undefined || bearer.length === 0) {
      return unauthorized(reply)
    }
    const now = Date.now()
    const cached = cacheGet(bearer, now)
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
      .where(
        and(eq(t.apiKey.keyPrefix, bearer.slice(0, 8)), isNull(t.apiKey.revokedAt)),
      )) as readonly ApiKeyRow[]

    const match = await findFirstAsync(rows, (row) => verify(row.keyHash.toString('utf8'), pepper + bearer))

    if (match === undefined || match.status !== 'active') {
      return unauthorized(reply)
    }

    await db.update(t.apiKey).set({ lastUsedAt: new Date() }).where(eq(t.apiKey.apiKeyId, match.apiKeyId))

    const ctx: TenantContext = {
      tenantId: match.tenantId,
      apiKeyId: match.apiKeyId,
      scopes: match.scopes,
      rateLimitRps: match.rateLimitRps,
      burst: match.burst,
    }
    cachePut(bearer, ctx, now)
    request.tenant = ctx
  }
}
