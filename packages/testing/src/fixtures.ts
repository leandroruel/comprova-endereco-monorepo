import { type Db } from '@comprova/db'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import * as t from '@comprova/db'

export const hashApiKey = (pepper: string, plaintext: string): Buffer =>
  createHmac('sha256', pepper).update(plaintext).digest()

export const ensureLegalBasis = async (db: Db): Promise<void> => {
  await db
    .insert(t.legalBasis)
    .values([
      { code: 'FRAUD_PREVENTION', description: 'Prevencao a fraude' },
      { code: 'CONTRACT_EXECUTION', description: 'Execucao de contrato' },
      { code: 'CONSENT', description: 'Consentimento do titular' },
    ])
    .onConflictDoNothing()
}

export interface CreateTenantOptions {
  readonly name?: string
  readonly rateLimitRps?: number
  readonly burst?: number
}

export const createTenant = async (db: Db, opts: CreateTenantOptions = {}): Promise<string> => {
  await ensureLegalBasis(db)
  const tenantId = randomUUID()
  await db.insert(t.tenant).values({
    tenantId,
    name: opts.name ?? 'test-tenant',
    rateLimitRps: opts.rateLimitRps ?? 50,
    burst: opts.burst ?? 100,
  })
  return tenantId
}

export interface CreateApiKeyOptions {
  readonly scopes?: readonly string[]
}

export const createApiKey = async (
  db: Db,
  tenantId: string,
  pepper: string,
  opts: CreateApiKeyOptions = {},
): Promise<{ readonly apiKeyId: string; readonly plaintext: string }> => {
  const apiKeyId = randomUUID()
  const plaintext = `cvk${randomBytes(18).toString('hex')}`
  const keyHash = hashApiKey(pepper, plaintext)
  await db.insert(t.apiKey).values({
    apiKeyId,
    tenantId,
    keyPrefix: plaintext.slice(0, 12),
    keyHash: Buffer.from(keyHash),
    scopes: [...(opts.scopes ?? ['validate:read', 'validate:write'])],
  })
  return { apiKeyId, plaintext }
}

export const createSubject = async (
  db: Db,
  tenantId: string,
  docType: 'CPF' | 'CNPJ' = 'CNPJ',
): Promise<string> => {
  const subjectId = randomUUID()
  await db.insert(t.subject).values({
    subjectId,
    tenantId,
    docType,
    docHmac: randomBytes(32),
  })
  return subjectId
}

export interface CreateValidationOptions {
  readonly status?: 'queued' | 'running' | 'partial' | 'completed' | 'failed' | 'expired'
  readonly verdict?: (typeof t.validation.$inferInsert)['verdict']
  readonly mode?: 'fast' | 'deep' | 'auto'
  readonly explanationSummary?: string
}

export const createValidation = async (
  db: Db,
  tenantId: string,
  subjectId: string,
  opts: CreateValidationOptions = {},
): Promise<string> => {
  const validationId = randomUUID()
  await db.insert(t.validation).values({
    validationId,
    tenantId,
    subjectId,
    mode: opts.mode ?? 'fast',
    status: opts.status ?? 'completed',
    verdict: opts.verdict ?? null,
    policyVersion: 'test-policy',
    legalBasis: 'FRAUD_PREVENTION',
    explanation: opts.explanationSummary !== undefined ? { summary: opts.explanationSummary } : null,
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
  })
  return validationId
}
