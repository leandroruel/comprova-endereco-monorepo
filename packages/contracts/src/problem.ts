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
  evidenceFileRequired: internal(400, 'EVIDENCE_FILE_REQUIRED', 'Evidence file is required'),
  invalidMultipart: internal(400, 'INVALID_MULTIPART', 'Malformed multipart request'),
  evidenceEmpty: internal(422, 'EVIDENCE_EMPTY', 'Evidence file is empty'),
  evidenceTooLarge: internal(413, 'EVIDENCE_TOO_LARGE', 'Evidence file exceeds the upload limit'),
  unsupportedEvidenceType: internal(415, 'UNSUPPORTED_EVIDENCE_TYPE', 'Evidence file type is not supported'),
  evidenceContentMismatch: internal(
    422,
    'EVIDENCE_CONTENT_MISMATCH',
    'Evidence content does not match the declared type',
  ),
  evidenceAlreadyExists: internal(
    409,
    'EVIDENCE_ALREADY_EXISTS',
    'A customer document already exists for this validation',
  ),
  evidenceStorageUnavailable: internal(
    503,
    'EVIDENCE_STORAGE_UNAVAILABLE',
    'Evidence storage is unavailable',
  ),
  evidencePersistenceFailed: internal(500, 'EVIDENCE_PERSISTENCE_FAILED', 'Evidence could not be persisted'),
}
