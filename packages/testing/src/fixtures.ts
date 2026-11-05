import { type Db, makeApiKeyHasher, newApiKey, keyPrefixOf } from '@comprova/db'
import { randomBytes, randomUUID } from 'node:crypto'
import * as t from '@comprova/db'

/** Escopo verify:m2m (definido em @comprova/contracts/plugins/scope). */
const VERIFY_M2M_SCOPE = 'verify:m2m'

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
  /** Tipo da chave: 'user' (dashboard/sessão) ou 'm2m' (máquina-a-máquina). Default: 'm2m'. */
  readonly keyType?: 'user' | 'm2m'
}

export const createApiKey = async (
  db: Db,
  tenantId: string,
  pepper: string,
  opts: CreateApiKeyOptions = {},
): Promise<{ readonly apiKeyId: string; readonly plaintext: string }> => {
  const apiKeyId = randomUUID()
  const plaintext = newApiKey()
  // Chaves de teste são M2M por padrão e incluem verify:m2m para serem
  // compatíveis com a política de autenticação que exige esse escopo em
  // endpoints de consumo. Testes que precisam de chaves sem verify:m2m devem
  // inserir diretamente no banco (como feito em m2m-auth.int.test.ts).
  const keyType = opts.keyType ?? 'm2m'
  const scopes = opts.scopes
    ? keyType === 'm2m'
      ? [...opts.scopes, VERIFY_M2M_SCOPE]
      : [...opts.scopes]
    : ['validate:read', 'validate:write', VERIFY_M2M_SCOPE]
  await db.insert(t.apiKey).values({
    apiKeyId,
    tenantId,
    keyPrefix: keyPrefixOf(plaintext),
    keyHash: makeApiKeyHasher(pepper).hash(plaintext),
    scopes,
    keyType,
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
