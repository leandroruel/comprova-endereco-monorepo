const API_BASE = '/v1'

/** Headers comuns para requisições autenticadas por sessão (cookie). */
function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
  }
}

/** Faz uma requisição à API e lança em caso de erro HTTP. */
async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...authHeaders(),
    ...(init.headers ? { ...(init.headers as Record<string, string>) } : {}),
  }
  // Somente envia Content-Type quando há corpo na requisição.
  if (init.body === undefined) {
    delete headers['Content-Type']
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers,
  })
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as {
      code?: string
      title?: string
      detail?: string
    }
    throw Object.assign(new Error(problem.title ?? problem.code ?? `HTTP ${res.status}`), {
      status: res.status,
    })
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** GET /api/me — dados da sessão corrente (sem API key). */
export async function getMe(): Promise<{
  id: string
  email: string
  name: string
  role: string
} | null> {
  const res = await fetch('/api/me', {
    method: 'GET',
    credentials: 'include',
  })
  if (res.status === 401 || res.status === 403) return null
  if (!res.ok) return null
  return (await res.json()) as {
    id: string
    email: string
    name: string
    role: string
  }
}

/** GET /organizations/terms-version — versão vigente dos termos (definida pelo servidor). */
export async function getTermsVersion(): Promise<{
  version: string
  approved: boolean
  documentHash: string | null
}> {
  return apiRequest('/organizations/terms-version', { method: 'GET' })
}

/** POST /organizations — cria uma organização Verifier. */
export async function createOrganization(body: {
  name: string
  legalName?: string
  document?: string
  termsVersion: string
  dataRegion?: string
}): Promise<{
  tenantId: string
  name: string
  legalName: string | null
  document: string | null
  type: string
  status: string
  onboardingStatus: string
  termsAcceptedAt: string | null
  termsAcceptedBy: string | null
  termsVersion: string | null
  dataRegion: string
  rateLimitRps: number
  burst: number
  monthlyQuota: number | null
  createdAt: string
  role: string | null
}> {
  return apiRequest('/organizations', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** GET /organizations — lista organizações às quais o usuário pertence. */
export async function listOrganizations(): Promise<
  Array<{
    tenantId: string
    name: string
    type: string
    status: string
    onboardingStatus: string
    termsAcceptedAt: string | null
    termsAcceptedBy: string | null
    termsVersion: string | null
    dataRegion: string
    rateLimitRps: number
    burst: number
    monthlyQuota: number | null
    createdAt: string
    role: string | null
  }>
> {
  return apiRequest('/organizations', { method: 'GET' })
}

/** GET /organizations/:tenantId — obtém uma organização. */
export async function getOrganization(tenantId: string): Promise<{
  tenantId: string
  name: string
  legalName: string | null
  document: string | null
  type: string
  status: string
  onboardingStatus: string
  termsAcceptedAt: string | null
  termsAcceptedBy: string | null
  termsVersion: string | null
  dataRegion: string
  rateLimitRps: number
  burst: number
  monthlyQuota: number | null
  createdAt: string
} | null> {
  try {
    return await apiRequest(`/organizations/${tenantId}`, { method: 'GET' })
  } catch (err) {
    if ((err as { status?: number } | null)?.status === 404) return null
    throw err
  }
}

/** POST /organizations/:tenantId/onboarding/complete — aceita termos e conclui onboarding. */
export async function completeOnboarding(
  tenantId: string,
  termsVersion: string,
  termsDocumentHash: string | null,
): Promise<{
  tenantId: string
  onboardingStatus: string
  termsAcceptedAt: string | null
  termsAcceptedBy: string | null
  termsVersion: string | null
  termsDocumentHash: string | null
}> {
  return apiRequest(`/organizations/${tenantId}/onboarding/complete`, {
    method: 'POST',
    body: JSON.stringify({ termsVersion, termsDocumentHash }),
  })
}

/** GET /organizations/:tenantId/members — lista membros da organização. */
export async function listMembers(tenantId: string): Promise<
  Array<{
    organizationMemberId: string
    tenantId: string
    userId: string
    userEmail: string
    userName: string
    role: string
    joinedAt: string
    invitedBy: string | null
  }>
> {
  return apiRequest(`/organizations/${tenantId}/members`, { method: 'GET' })
}

/** POST /organizations/:tenantId/members — adiciona um membro. */
export async function addMember(
  tenantId: string,
  body: { email: string; role: 'owner' | 'admin' | 'member' },
): Promise<{
  organizationMemberId: string
  tenantId: string
  userId: string
  userEmail: string
  userName: string
  role: string
  joinedAt: string
  invitedBy: string | null
}> {
  return apiRequest(`/organizations/${tenantId}/members`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** POST /organizations/:tenantId/invitations — cria um convite. Retorna o token apenas uma vez. */
export async function createInvitation(
  tenantId: string,
  body: { email: string; role: 'owner' | 'admin' | 'member'; expiresInDays?: number },
): Promise<{
  organizationInvitationId: string
  tenantId: string
  email: string
  role: string
  expiresAt: string
  createdAt: string
  token: string
}> {
  return apiRequest(`/organizations/${tenantId}/invitations`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** POST /m2m/api-keys — cria uma credencial M2M. Retorna o segredo em claro apenas agora. */
export async function createApiKey(body: {
  tenantId: string
  name: string
  scopes?: string[]
  keyType?: 'user' | 'm2m'
  expiresInDays?: number
}): Promise<{
  apiKey: {
    apiKeyId: string
    tenantId: string
    keyPrefix: string
    key: string | undefined
    scopes: string[]
    keyType: string
    revokedAt: string | null
    lastUsedAt: string | null
    createdAt: string
  }
  secret: string
}> {
  const query = new URLSearchParams({ tenantId: body.tenantId })
  return apiRequest(`/m2m/api-keys?${query.toString()}`, {
    method: 'POST',
    body: JSON.stringify({
      name: body.name,
      scopes: body.scopes,
      keyType: body.keyType,
      expiresInDays: body.expiresInDays,
    }),
  })
}

/** Item de listagem de validações (contrato `ValidationListItemDtoSchema`). */
export interface ValidationListItem {
  validation_id: string
  status: string
  verdict: string | null
  score: number | null
  confidence: number | null
  has_customer_document: boolean
  document_processing: boolean
  created_at: string
  expires_at: string
}

/**
 * GET /v1/validations — lista paginada de validações da organização.
 * A autorização vem da sessão (cookie): o `tenantId` é apenas contexto de
 * consulta validado por membership no backend.
 */
export async function listValidations(
  tenantId: string,
  pagination: { limit?: number; offset?: number } = {},
): Promise<{
  validations: ValidationListItem[]
  total: number
  limit: number
  offset: number
}> {
  const query = new URLSearchParams({
    tenantId,
    limit: String(pagination.limit ?? 20),
    offset: String(pagination.offset ?? 0),
  })
  return apiRequest(`/validations?${query.toString()}`, { method: 'GET' })
}

/** DTO público do detalhe (contrato `ValidationDtoSchema`). Campos usados pelo UI. */
export interface ValidationDetail {
  validation_id: string
  status: string
  verdict: string | null
  confidence: number | null
  score: number | null
  policy_version: string | null
  explanation: string | null
  explanation_detail: {
    code: string
    message: string
    supporting_evidence: string[]
    contradicting_evidence: string[]
  } | null
  created_at: string
  expires_at: string
  progress: {
    status: 'in_progress' | 'completed' | 'failed'
    steps: { stage: string; status: string }[]
  } | null
  evidence_summary: { supporting: number; contradicting: number; unknown: number } | null
  claim: {
    id: string
    type: string
    subject: { type: string; id: string }
    target: { type: string; id: string | null }
  } | null
  evidence_verification: {
    status: string
    method: string
    source: { kind: string; id: string; authority: string | null; environment: string }
    document: string
    address: string
    holder: string
    analysis_id: string
    analyzer: { id: string; version: string }
    contract_version: string
    observed_at: string
    limitations: string[]
    error_codes: string[]
  } | null
  fiscal_verification: {
    status: string
    method: string
    document: string
    address: string
    holder: string
    observed_at: string
    limitations: string[]
    error_codes: string[]
  } | null
  fiscal_reference: string | null
  fiscal_reassessment: string | null
  has_customer_document?: boolean
  signals: {
    checker: string
    checker_version: string
    stance: string
    strength: number
    confidence: number
    source: string
    observed_at: string
    ttl_seconds: number
  }[]
}

/**
 * GET /v1/validations/:id — detalhe/resultado da validação. O `tenantId` é
 * exigido pelo fluxo de sessão e validado por membership no backend.
 */
export async function getValidation(tenantId: string, validationId: string): Promise<ValidationDetail> {
  const query = new URLSearchParams({ tenantId })
  return apiRequest(`/validations/${validationId}?${query.toString()}`, { method: 'GET' })
}

/** GET /m2m/api-keys — lista credenciais da organização (sem segredo). */
export async function listApiKeys(tenantId: string): Promise<{
  apiKeys: Array<{
    apiKeyId: string
    tenantId: string
    keyPrefix: string
    key: undefined
    scopes: string[]
    keyType: string
    revokedAt: string | null
    lastUsedAt: string | null
    createdAt: string
  }>
}> {
  const query = new URLSearchParams({ tenantId })
  return apiRequest(`/m2m/api-keys?${query.toString()}`, { method: 'GET' })
}

/** DELETE /m2m/api-keys/:apiKeyId — revoga uma credencial M2M. */
export async function revokeApiKey(tenantId: string, apiKeyId: string): Promise<{ revoked: boolean }> {
  const query = new URLSearchParams({ tenantId })
  return apiRequest(`/m2m/api-keys/${apiKeyId}?${query.toString()}`, {
    method: 'DELETE',
  })
}
