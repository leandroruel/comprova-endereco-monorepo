/**
 * Cliente público da jornada do Holder (F4.1).
 *
 * Autenticação exclusiva por token opaco em `X-Holder-Token`. O token nunca é
 * persistido: vive apenas em memória no componente e é removido da URL após a
 * captura. Todas as requisições usam `cache: 'no-store'` e
 * `credentials: 'omit'` (não envia cookies do dashboard).
 */

const API_BASE = import.meta.env.VITE_API_URL ?? ''

export type HolderConsentStatus = {
  readonly granted: boolean
  readonly termsVersion: string | null
  readonly acceptedAt: string | null
}

export type HolderTerms = {
  readonly version: string | null
  readonly approved: boolean
  readonly documentHash: string | null
  readonly content: string | null
  readonly hashValid: boolean
}

export type HolderAccessDocument = {
  readonly documentId: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly originalFilename: string
  readonly createdAt: string
}

export type HolderAccessItem = {
  readonly itemId: string
  readonly description: string
  readonly required: boolean
  readonly documentType?: string
  readonly value: string | null
  readonly documents: HolderAccessDocument[]
}

export type HolderAccessView = {
  readonly requestId: string
  readonly type: string
  readonly purpose: string
  readonly state: 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'expired'
  readonly status: string
  readonly consent: HolderConsentStatus
  readonly terms: HolderTerms
  readonly expiresAt: string | null
  readonly completedAt: string | null
  readonly items: HolderAccessItem[]
}

export type HolderProcessing = {
  readonly processingId: string
  readonly holderInformationRequestId: string
  readonly state: 'awaiting' | 'processing' | 'processed' | 'partial' | 'failed'
  readonly attempts: number
  readonly lastError: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly processedAt: string | null
}

export class HolderApiError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(message: string, status: number, code: string | null) {
    super(message)
    this.name = 'HolderApiError'
    this.status = status
    this.code = code
  }
}

const parseProblem = async (res: Response): Promise<HolderApiError> => {
  const body = (await res.json().catch(() => null)) as {
    title?: unknown
    code?: unknown
  } | null
  const title = typeof body?.title === 'string' && body.title.length > 0 ? body.title : null
  const code = typeof body?.code === 'string' ? body.code : null
  // Nunca ecoa o token nem detalhes internos: apenas título/código do problem.
  return new HolderApiError(title ?? `Falha na requisição (HTTP ${res.status})`, res.status, code)
}

const holderRequest = async <T>(token: string, path: string, init: RequestInit = {}): Promise<T> => {
  const headers = new Headers(init.headers)
  headers.set('X-Holder-Token', token)

  const res = await fetch(`${API_BASE}/v1/holder-access${path}`, {
    ...init,
    headers,
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  })

  if (!res.ok) throw await parseProblem(res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const getHolderAccess = (token: string): Promise<HolderAccessView> =>
  holderRequest(token, '', { method: 'GET' })

export const registerHolderConsent = (token: string, termsVersion: string): Promise<HolderConsentStatus> =>
  holderRequest(token, '/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ termsVersion }),
  })

export const saveHolderItem = (token: string, itemId: string, value: string): Promise<HolderAccessView> =>
  holderRequest(token, `/items/${encodeURIComponent(itemId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  })

export const uploadHolderDocument = (
  token: string,
  itemId: string,
  file: File,
): Promise<HolderAccessView> => {
  const form = new FormData()
  form.append('file', file)
  return holderRequest(token, `/items/${encodeURIComponent(itemId)}/documents`, {
    method: 'POST',
    body: form,
  })
}

export const deleteHolderDocument = (token: string, itemId: string, documentId: string): Promise<void> =>
  holderRequest(token, `/items/${encodeURIComponent(itemId)}/documents/${documentId}`, {
    method: 'DELETE',
  })

export const submitHolderRequest = (token: string): Promise<HolderAccessView> =>
  holderRequest(token, '/submit', { method: 'POST' })

/**
 * Processamento documental da submissão. Enquanto o worker ainda não criou o
 * registro, a API responde 404: tratamos como `null` (ainda não iniciado), não
 * como erro de acesso.
 */
export const getHolderProcessing = async (
  token: string,
  requestId: string,
): Promise<HolderProcessing | null> => {
  try {
    return await holderRequest<HolderProcessing>(
      token,
      `/items/${encodeURIComponent(requestId)}/processing`,
      { method: 'GET' },
    )
  } catch (error) {
    if (error instanceof HolderApiError && error.status === 404) return null
    throw error
  }
}
