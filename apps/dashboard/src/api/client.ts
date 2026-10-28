// Origem da API e chave: a chave vem do `.env` (o `envDir` do Vite aponta para
// a raiz do repo — ver README e `.env.example`). Sem ela a API responde 401.
// Atenção: isto é uma facilidade de desenvolvimento — num dashboard público a
// chave não pode viver no bundle (precisaria de sessão/BFF).
export const API_BASE = 'http://localhost:3000'

const apiKey = import.meta.env.VITE_API_KEY ?? ''
if (apiKey === '' && import.meta.env.DEV && import.meta.env.MODE !== 'test') {
  console.error('[api] VITE_API_KEY não definido — copie .env.example para .env')
}
export const API_KEY = apiKey

export interface ValidationSignal {
  checker: string
  checker_version: string
  stance: 'supports' | 'contradicts' | 'neutral' | 'unknown'
  strength: number
  confidence: number
  source: string
  observed_at: string
  ttl_seconds: number
  detail: Record<string, unknown>
  evidence_id: string | null
}

export interface AssessmentExplanationDto {
  code: string
  message: string
  supporting_evidence: string[]
  contradicting_evidence: string[]
}

export interface ClaimDto {
  id: string
  type: 'business_registered_address' | 'address_exists'
  subject: { type: 'organization' | 'person'; id: string }
  target: { type: 'address'; id: string | null }
}

export interface EvidenceSummaryDto {
  supporting: number
  contradicting: number
  unknown: number
}

export interface VerificationSourceDto {
  kind: string
  id: string
  authority: string | null
  environment: 'production' | 'homologation' | 'local'
}

export interface EvidenceVerificationDto {
  status: 'completed' | 'invalid' | 'inconclusive' | 'unsupported' | 'unavailable'
  method: string
  source: VerificationSourceDto
  document: 'authentic' | 'not_found' | 'invalid' | 'inconclusive' | 'unavailable' | 'unsupported'
  address: 'matches' | 'differs' | 'not_extracted'
  holder: 'matches' | 'differs' | 'not_extracted'
  analysis_id: string
  analyzer: { id: string; version: string }
  contract_version: string
  observed_at: string
  limitations: string[]
  error_codes: string[]
  comparison: {
    address: { compared_fields: string[]; reason_codes: string[] }
    holder: { reference: string; reason_codes: string[] }
  }
}

export interface FiscalVerificationDto {
  status: 'completed' | 'not_found' | 'invalid' | 'inconclusive' | 'unsupported' | 'unavailable'
  method: string
  source: VerificationSourceDto
  document: 'authentic' | 'not_found' | 'invalid' | 'inconclusive' | 'unavailable' | 'unsupported'
  address: 'matches' | 'differs' | 'not_extracted'
  holder: 'matches' | 'differs' | 'not_extracted'
  adapter_version: string
  contract_version: string
  observed_at: string
  limitations: string[]
  error_codes: string[]
}

export type ValidationProgressStage =
  'reading_document' | 'reading_qr' | 'consulting_provider' | 'verifying_authenticity' | 'comparing_evidence'

export type ValidationProgressStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'

export interface ValidationProgressStep {
  stage: ValidationProgressStage
  status: ValidationProgressStepStatus
}

export interface ValidationProgressDto {
  status: 'in_progress' | 'completed' | 'failed'
  steps: ValidationProgressStep[]
}

/**
 * Endereço informado pelo usuário no dashboard (contrato `AddressInputSchema`
 * da API). Só é enviado quando o documento é um CPF — CNPJ continua usando o
 * endereço vindo do snapshot da Receita Federal.
 */
export interface AddressInput {
  tipo_logradouro?: string
  logradouro: string
  numero?: string
  complemento?: string
  bairro?: string
  cep?: string
  uf?: string
  municipio?: string
  municipio_ibge?: number
  country_code?: string
}

export interface CepAddressLookup {
  logradouro: string
  bairro: string
  municipio: string
  uf: string
}

type CepLookupResponse = {
  street?: string | null
  logradouro?: string | null
  neighborhood?: string | null
  bairro?: string | null
  city?: string | null
  localidade?: string | null
  state?: string | null
  uf?: string | null
  erro?: boolean | string
}

const addressFromBrasilApi = (body: CepLookupResponse): CepAddressLookup | null => {
  const uf = body.state ?? body.uf
  if (uf === null || uf === undefined || uf === '') return null

  return {
    logradouro: body.street ?? body.logradouro ?? '',
    bairro: body.neighborhood ?? body.bairro ?? '',
    municipio: body.city ?? body.localidade ?? '',
    uf,
  }
}

const addressFromViaCep = (body: CepLookupResponse): CepAddressLookup | null => {
  if (
    body.erro === true ||
    body.erro === 'true' ||
    body.uf === null ||
    body.uf === undefined ||
    body.uf === ''
  ) {
    return null
  }

  return {
    logradouro: body.logradouro ?? '',
    bairro: body.bairro ?? '',
    municipio: body.localidade ?? '',
    uf: body.uf,
  }
}

const lookupViaCep = async (cep: string, signal?: AbortSignal): Promise<CepAddressLookup | null> => {
  const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`CEP fallback lookup failed: HTTP ${res.status}`)
  return addressFromViaCep((await res.json()) as CepLookupResponse)
}

/** Consulta pública de CEP usada para sugerir os campos do endereço no formulário. */
export async function getAddressByCep(cep: string, signal?: AbortSignal): Promise<CepAddressLookup | null> {
  const clean = cep.replace(/\D+/g, '')
  if (clean.length !== 8) return null

  let primary: CepAddressLookup | null = null
  try {
    const res = await fetch(`https://brasilapi.com.br/api/cep/v2/${clean}`, { signal })
    if (res.ok) {
      primary = addressFromBrasilApi((await res.json()) as CepLookupResponse)
      if (primary !== null && primary.logradouro !== '') return primary
    } else if (res.status !== 404) {
      throw new Error(`CEP lookup failed: HTTP ${res.status}`)
    }
  } catch (error) {
    if (signal?.aborted || (error as { name?: unknown }).name === 'AbortError') throw error
  }

  try {
    return (await lookupViaCep(clean, signal)) ?? primary
  } catch (error) {
    if (primary !== null) return primary
    throw error
  }
}

export interface ValidationDto {
  validation_id: string
  status: string
  verdict: string | null
  confidence: number | null
  score: number | null
  policy_version: string | null
  address: { building_key: string; country: string; uf: string | null; geo_precision: string } | null
  signals: ValidationSignal[]
  claim?: ClaimDto | null
  evidence_summary?: EvidenceSummaryDto | null
  evidence_verification?: EvidenceVerificationDto | null
  fiscal_verification?: FiscalVerificationDto | null
  /** Status da referência fiscal extraída do comprovante; `found` = consulta esperada. */
  fiscal_reference?: 'found' | 'not_found' | 'inconclusive' | 'unsupported' | null
  /** Estado durável da reavaliação pós-consulta fiscal (null = não registrada). */
  fiscal_reassessment?: 'pending' | 'completed' | null
  /** Progresso observável do fluxo de comprovante, derivado do estado durável. */
  progress?: ValidationProgressDto | null
  explanation: string | null
  explanation_detail?: AssessmentExplanationDto | null
  address_unavailable_reason?: 'cnpj_not_in_snapshot' | 'address_not_provided' | null
  created_at: string
  expires_at: string
}

export interface StatsDto {
  total: number
  unique_documents: number
  by_doc_type: Record<string, number>
  by_verdict: Record<string, number>
  completed: number
  partial: number
  failed: number
  avg_confidence: number
  avg_score: number
}

export async function getStats(): Promise<StatsDto> {
  const res = await fetch(`${API_BASE}/v1/stats`, {
    credentials: 'include',
    headers: { Authorization: `Bearer ${API_KEY}` },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as StatsDto
}

/**
 * Cria uma validação (`POST /v1/validations`).
 *
 * `address` só é incluído no payload quando o documento é um CPF — CNPJ usa o
 * endereço do snapshot da Receita Federal. `country_code` recebe o padrão `BR`
 * quando o chamador não informar.
 */
export async function createValidation(
  document: string,
  mode: string = 'fast',
  address?: AddressInput | null,
): Promise<ValidationDto> {
  const isCpf = document.replace(/\D+/g, '').length === 11
  const addressPayload =
    isCpf && address != null ? { ...address, country_code: address.country_code ?? 'BR' } : null
  const res = await fetch(`${API_BASE}/v1/validations`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      document: { type: isCpf ? 'CPF' : 'CNPJ', value: document },
      mode,
      legal_basis: 'FRAUD_PREVENTION',
      ...(addressPayload !== null ? { address: addressPayload } : {}),
    }),
  })
  if (!res.ok) {
    const problem = (await res.json()) as { code?: string; title?: string }
    throw new Error(problem.title ?? problem.code ?? `HTTP ${res.status}`)
  }
  return (await res.json()) as ValidationDto
}

export async function getValidation(id: string): Promise<ValidationDto> {
  const res = await fetch(`${API_BASE}/v1/validations/${id}`, {
    credentials: 'include',
    headers: { Authorization: `Bearer ${API_KEY}` },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as ValidationDto
}

/**
 * Upload do comprovante (PDF/imagem) para a validação. O backend extrai a
 * referência fiscal do QR do próprio artefato — a referência NF3e nunca é
 * digitada/enviada pelo browser.
 */
export async function uploadEvidence(
  validationId: string,
  file: File,
): Promise<{ evidence_id: string; artifact_id: string; status: string }> {
  const body = new FormData()
  body.append('file', file, file.name)
  const res = await fetch(`${API_BASE}/v1/validations/${validationId}/evidence`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Idempotency-Key': crypto.randomUUID(),
    },
    body,
  })
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; title?: string }
    throw new Error(problem.title ?? problem.code ?? `HTTP ${res.status}`)
  }
  return (await res.json()) as { evidence_id: string; artifact_id: string; status: string }
}

export async function getReady(): Promise<{ status: string }> {
  const res = await fetch(`${API_BASE}/readyz`)
  return (await res.json()) as { status: string }
}
