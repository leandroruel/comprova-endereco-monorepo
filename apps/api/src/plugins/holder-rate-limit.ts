import { PROBLEM_CONTENT_TYPE, problem } from '@comprova/contracts'
import type { Logger } from '@comprova/observability'
import { createHash } from 'node:crypto'
import type Redis from 'ioredis'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { consumeTokenBucket } from './rate-limit.js'

/**
 * Rate limiting do acesso do Holder (F4.2).
 *
 * Camadas separadas:
 *   - ip:     todas as requisições, por IP;
 *   - token:  por prefixo de token (SHA-256, nunca o token em claro);
 *   - upload: uploads por token;
 *   - inválid: tentativas com token ausente/malformado/inexistente, por IP.
 *
 * Falha do Redis (erro, timeout ou conexão indisponível) é FAIL CLOSED: a
 * requisição recebe `503 RATE_LIMIT_UNAVAILABLE`. Nunca caímos no caminho
 * "permite" por indisponibilidade do limitador.
 */

export interface HolderRateLimitLayer {
  readonly ratePerSecond: number
  readonly burst: number
}

export const HOLDER_RATE_LIMIT_LAYERS = {
  ip: { ratePerSecond: 2, burst: 120 },
  token: { ratePerSecond: 2, burst: 120 },
  upload: { ratePerSecond: 10 / 60, burst: 10 },
  invalid: { ratePerSecond: 10 / 60, burst: 10 },
} as const satisfies Record<string, HolderRateLimitLayer>

const REDIS_TIMEOUT_MS = 500

const hashKeyPart = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 32)

const clientIpOf = (request: FastifyRequest): string => request.ip ?? 'unknown'

const holderTokenOf = (request: FastifyRequest): string | undefined => {
  const value = request.headers['x-holder-token']
  if (typeof value === 'string' && value.length > 0) return value
  if (Array.isArray(value) && value.length > 0) return value[0]
  return undefined
}

class RateLimitUnavailableError extends Error {
  constructor(cause: unknown) {
    super('holder rate limit unavailable')
    this.name = 'RateLimitUnavailableError'
    this.cause = cause
  }
}

const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RateLimitUnavailableError('timeout')), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export interface HolderRateLimits {
  readonly ip: (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>
  readonly token: (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>
  readonly upload: (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>
  readonly invalid: (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>
}

export const makeHolderRateLimits = (redis: Redis, logger: Logger): HolderRateLimits => {
  const enforce = async (
    layer: keyof typeof HOLDER_RATE_LIMIT_LAYERS,
    keyPart: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> => {
    const config = HOLDER_RATE_LIMIT_LAYERS[layer]
    const key = `rl:holder:${layer}:${keyPart}`
    let result: Awaited<ReturnType<typeof consumeTokenBucket>>
    try {
      result = await withTimeout(
        consumeTokenBucket(redis, key, config.ratePerSecond, config.burst),
        REDIS_TIMEOUT_MS,
      )
    } catch (error) {
      logger.error(
        {
          layer,
          request_id: request.id,
          route: request.routeOptions.url,
          error_name: error instanceof Error ? error.name : 'unknown',
        },
        'holder rate limit unavailable',
      )
      return reply
        .code(503)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problem(503, 'RATE_LIMIT_UNAVAILABLE', 'Rate limit unavailable'))
    }

    reply.header('RateLimit-Limit', config.burst)
    reply.header('RateLimit-Remaining', Math.max(0, result.remaining))
    reply.header('RateLimit-Reset', result.refillSeconds)

    if (!result.allowed) {
      const retryAfter = Math.max(1, result.refillSeconds)
      reply.header('Retry-After', retryAfter)
      return reply
        .code(429)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problem(429, 'RATE_LIMITED', 'Rate limit exceeded', `Retry after ${retryAfter} seconds`))
    }
  }

  return {
    ip: (request, reply) => enforce('ip', hashKeyPart(clientIpOf(request)), request, reply),
    token: (request, reply) => {
      const token = holderTokenOf(request)
      if (token === undefined) return Promise.resolve()
      return enforce('token', hashKeyPart(token.slice(0, 16)), request, reply)
    },
    upload: (request, reply) => {
      const token = holderTokenOf(request)
      if (token === undefined) return Promise.resolve()
      return enforce('upload', hashKeyPart(token.slice(0, 16)), request, reply)
    },
    invalid: (request, reply) => enforce('invalid', hashKeyPart(clientIpOf(request)), request, reply),
  }
}
