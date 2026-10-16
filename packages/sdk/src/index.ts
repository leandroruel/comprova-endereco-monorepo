export interface AssessmentExplanationDto {
  readonly code: string
  readonly message: string
  readonly supporting_evidence: readonly string[]
  readonly contradicting_evidence: readonly string[]
}

export interface ClaimDto {
  readonly id: string
  readonly type: 'business_registered_address' | 'address_exists'
  readonly subject: { readonly type: 'organization' | 'person'; readonly id: string }
  readonly target: { readonly type: 'address'; readonly id: string | null }
}

export interface EvidenceSummaryDto {
  readonly supporting: number
  readonly contradicting: number
  readonly unknown: number
}

export interface ValidationDto {
  readonly validation_id: string
  readonly status: string
  readonly verdict: string | null
  readonly confidence: number | null
  readonly score: number | null
  readonly policy_version: string | null
  readonly address: {
    readonly building_key: string
    readonly country: string
    readonly uf: string | null
    readonly geo_precision: string
  } | null
  readonly signals: ReadonlyArray<Record<string, unknown>>
  readonly claim?: ClaimDto | null
  readonly evidence_summary?: EvidenceSummaryDto | null
  readonly explanation: string | null
  readonly explanation_detail?: AssessmentExplanationDto | null
  readonly created_at: string
  readonly expires_at: string
}

export interface CreateValidationInput {
  readonly document: { readonly type: 'CPF' | 'CNPJ'; readonly value: string }
  readonly address?: unknown
  readonly mode?: 'fast' | 'deep' | 'auto'
  readonly legal_basis: 'FRAUD_PREVENTION' | 'CONTRACT_EXECUTION' | 'CONSENT'
  readonly consent_ref?: string | null
  readonly options?: { readonly include_evidence?: boolean; readonly max_tier?: number }
}

export interface SdkOptions {
  readonly baseUrl: string
  readonly apiKey: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

export class SdkError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`comprova sdk: ${status} ${code}`)
  }
}

const request = async <T>(
  options: SdkOptions,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> => {
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)
  try {
    const res = await doFetch(`${options.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        ...(extraHeaders ?? {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    })
    const json = (await res.json()) as unknown
    if (res.status >= 400) {
      throw new SdkError(res.status, (json as { code?: string })?.code ?? 'HTTP_ERROR')
    }
    return json as T
  } finally {
    clearTimeout(timer)
  }
}

export const createClient = (options: SdkOptions) => ({
  createValidation: (body: CreateValidationInput, idempotencyKey?: string): Promise<ValidationDto> =>
    request<ValidationDto>(options, 'POST', '/v1/validations', body, {
      ...(idempotencyKey !== undefined ? { 'Idempotency-Key': idempotencyKey } : {}),
    }),

  getValidation: (id: string): Promise<ValidationDto> =>
    request<ValidationDto>(options, 'GET', `/v1/validations/${id}`),

  contestValidation: (id: string, reason: string): Promise<{ contested: boolean; validation_id: string }> =>
    request<{ contested: boolean; validation_id: string }>(options, 'POST', `/v1/validations/${id}/contest`, {
      reason,
    }),

  createBatch: (body: {
    readonly items: ReadonlyArray<{ readonly type: 'CPF' | 'CNPJ'; readonly value: string }>
    readonly mode?: 'fast' | 'deep' | 'auto'
    readonly legal_basis: 'FRAUD_PREVENTION' | 'CONTRACT_EXECUTION' | 'CONSENT'
  }): Promise<{ batch_id: string; total_items: number; status: string }> =>
    request<{ batch_id: string; total_items: number; status: string }>(options, 'POST', '/v1/batches', body),

  getBatch: (
    id: string,
  ): Promise<{
    batch_id: string
    status: string
    total_items: number
    items: ReadonlyArray<Record<string, unknown>>
  }> => request(options, 'GET', `/v1/batches/${id}`),

  listSubjectValidations: (
    id: string,
  ): Promise<{ subject_id: string; validations: ReadonlyArray<Record<string, unknown>> }> =>
    request(options, 'GET', `/v1/subjects/${id}/validations`),

  eraseSubject: (id: string): Promise<{ erased: boolean; validations_removed: number }> =>
    request(options, 'DELETE', `/v1/subjects/${id}`),

  createWebhook: (body: {
    readonly url: string
    readonly events?: readonly string[]
  }): Promise<{ endpoint_id: string; secret: string }> => request(options, 'POST', '/v1/webhooks', body),

  deleteWebhook: (id: string): Promise<{ deleted: boolean }> =>
    request(options, 'DELETE', `/v1/webhooks/${id}`),
})
