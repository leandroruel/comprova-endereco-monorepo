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

export const makeAuthenticate = (db: Db, pepper: string) => {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const header = request.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined
    if (bearer === undefined || bearer.length === 0) {
      return unauthorized(reply)
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

    request.tenant = {
      tenantId: match.tenantId,
      apiKeyId: match.apiKeyId,
      scopes: match.scopes,
      rateLimitRps: match.rateLimitRps,
      burst: match.burst,
    }
  }
}
