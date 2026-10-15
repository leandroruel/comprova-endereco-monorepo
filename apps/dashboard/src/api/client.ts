const API_BASE = 'http://localhost:3000'
const API_KEY = 'cvk_-oHrqOQw3f50608XbFVB74C-OwyVSDTM'

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

export interface ValidationDto {
  validation_id: string
  status: string
  verdict: string | null
  confidence: number | null
  score: number | null
  policy_version: string | null
  address: { building_key: string; country: string; uf: string | null; geo_precision: string } | null
  signals: ValidationSignal[]
  explanation: string | null
  created_at: string
  expires_at: string
}

export async function createValidation(document: string, mode: string = 'fast'): Promise<ValidationDto> {
  const isCpf = document.replace(/\D+/g, '').length === 11
  const res = await fetch(`${API_BASE}/v1/validations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      document: { type: isCpf ? 'CPF' : 'CNPJ', value: document },
      mode,
      legal_basis: 'FRAUD_PREVENTION',
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
    headers: { Authorization: `Bearer ${API_KEY}` },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as ValidationDto
}

export async function getReady(): Promise<{ status: string }> {
  const res = await fetch(`${API_BASE}/readyz`)
  return (await res.json()) as { status: string }
}
