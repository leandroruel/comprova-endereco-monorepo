import { z } from 'zod'
import type { Db } from '@comprova/db'
import { PROBLEM_CONTENT_TYPE, problem } from '@comprova/contracts'
import type { FastifyReply } from 'fastify'

export const sendProblem = (
  reply: FastifyReply,
  status: number,
  code: string,
  title: string,
  detail?: string,
): FastifyReply =>
  reply
    .code(status)
    .type(PROBLEM_CONTENT_TYPE)
    .send(problem(status, code, title, detail))

export const CreateApiKeyBody = z.object({
  tenantId: z.string().uuid(),
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).default(['validate:read', 'validate:write', 'verify:m2m']),
  keyType: z.enum(['user', 'm2m']).default('m2m'),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
})

export const ApiKeyIdParams = z.object({
  apiKeyId: z.string().uuid(),
})

export const ApiKeyResponse = z.object({
  apiKeyId: z.string().uuid(),
  tenantId: z.string().uuid(),
  keyPrefix: z.string(),
  key: z.string().optional(),
  scopes: z.array(z.string()),
  keyType: z.string(),
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
})

export const ApiKeyDtoSchema = z.object({
  apiKeys: z.array(ApiKeyResponse),
})

export const ApiKeyCreatedResponse = z.object({
  apiKey: ApiKeyResponse,
  secret: z.string(),
})

export interface M2MControllerDeps {
  readonly db: Db
  readonly apiKeyPepper: string
}
