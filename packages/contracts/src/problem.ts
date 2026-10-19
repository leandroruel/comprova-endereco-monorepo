export interface Problem {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly code: string
  readonly detail?: string
  readonly request_id?: string
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json'

export const problem = (status: number, code: string, title: string, detail?: string): Problem => ({
  type: `https://comprova.dev/problems/${code}`,
  title,
  status,
  code,
  ...(detail !== undefined ? { detail } : {}),
})

const internal =
  (status: number, code: string, title: string) =>
  (detail?: string): Problem =>
    problem(status, code, title, detail)

export const problems = {
  unauthorized: internal(401, 'UNAUTHORIZED', 'Missing or invalid API key'),
  forbidden: internal(403, 'FORBIDDEN', 'Insufficient scope'),
  notFound: internal(404, 'NOT_FOUND', 'Resource not found'),
  rateLimited: internal(429, 'RATE_LIMITED', 'Rate limit exceeded'),
  quotaExceeded: internal(429, 'QUOTA_EXCEEDED', 'Monthly quota exceeded'),
  invalidDocument: internal(422, 'INVALID_DOCUMENT', 'Document failed integrity checks'),
  addressRequiredForCpf: internal(
    422,
    'ADDRESS_REQUIRED_FOR_CPF',
    'CPF validations require an informed address',
  ),
  legalBasisRequired: internal(422, 'LEGAL_BASIS_REQUIRED', 'A legal basis is required for this request'),
  providerUnavailable: internal(503, 'PROVIDER_UNAVAILABLE', 'An external provider is unavailable'),
  unprocessableAddress: internal(422, 'UNPROCESSABLE_ADDRESS', 'Address could not be canonicalized'),
  credentialNotIssuable: internal(
    409,
    'CREDENTIAL_NOT_ISSUABLE',
    'Validation cannot be issued as a credential',
  ),
}
