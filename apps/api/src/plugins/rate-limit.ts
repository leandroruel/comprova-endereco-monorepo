import { PROBLEM_CONTENT_TYPE, problems } from '@comprova/contracts'
import type Redis from 'ioredis'
import type { FastifyReply, FastifyRequest } from 'fastify'

const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) + tonumber(t[2]) / 1000000
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then
  tokens = burst
  ts = now
end
local delta = math.max(0, now - ts)
tokens = math.min(burst, tokens + delta * rate)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
local safe_rate = math.max(rate, 0.001)
local ttl = math.ceil(burst / safe_rate) + 60
redis.call('EXPIRE', key, ttl)
local refill = math.max(0, math.ceil((burst - tokens) / safe_rate))
return {allowed, math.floor(tokens), refill}
`

export function makeRateLimiter(redis: Redis) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const tenant = request.tenant
    if (tenant === undefined) {
      return
    }
    const key = `rl:${tenant.tenantId}:${tenant.apiKeyId}`
    const result = (await redis.eval(TOKEN_BUCKET_LUA, 1, key, tenant.rateLimitRps, tenant.burst)) as [
      number,
      number,
      number,
    ]
    const [allowed, remaining, refill] = result
    reply.header('RateLimit-Limit', tenant.burst)
    reply.header('RateLimit-Remaining', Math.max(0, remaining))
    reply.header('RateLimit-Reset', refill)
    if (allowed !== 1) {
      reply.header('Retry-After', Math.max(1, refill))
      return reply
        .code(429)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problems.rateLimited(`Retry after ${Math.max(1, refill)} seconds`))
    }
  }
}
