import { DocumentIntelligenceResponseSchema, type DocumentIntelligenceResponse } from '@comprova/contracts'
import type { Logger } from '@comprova/observability'

/**
 * Cliente HTTP do serviço Document Intelligence (apps/document-intelligence).
 *
 * Responsabilidades:
 * - falhar fechado quando `DOCUMENT_INTELLIGENCE_URL` não está configurada;
 * - aplicar timeout por requisição;
 * - validar status HTTP e o contrato (camelCase) antes de devolver qualquer dado;
 * - nunca propagar detalhes internos do Marker/Surya para o domínio.
 */

export type DocumentIntelligenceErrorKind =
  'not_configured' | 'timeout' | 'unavailable' | 'invalid_response' | 'upstream_error' | 'too_large'

export class DocumentIntelligenceError extends Error {
  constructor(
    readonly kind: DocumentIntelligenceErrorKind,
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message)
    this.name = 'DocumentIntelligenceError'
  }
}

export interface DocumentIntelligenceClientConfig {
  readonly url: string | undefined
  readonly timeoutMs: number
  readonly maxFileSizeMb: number
  readonly logger: Logger
}

export interface ParsePdfInput {
  readonly data: Buffer
  readonly filename: string
  readonly documentId: string
  readonly signal?: AbortSignal | undefined
}

export interface DocumentIntelligenceClient {
  /** `false` quando a URL não está configurada (rota responde 503). */
  readonly enabled: boolean
  readonly maxFileSizeBytes: number
  parsePdf(input: ParsePdfInput): Promise<DocumentIntelligenceResponse>
}

const MB = 1024 * 1024

const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  (error as { name?: unknown }).name === 'AbortError'

export const makeDocumentIntelligenceClient = (
  config: DocumentIntelligenceClientConfig,
): DocumentIntelligenceClient => {
  const baseUrl = config.url?.replace(/\/+$/, '')
  const maxFileSizeBytes = config.maxFileSizeMb * MB

  const parsePdf = async ({
    data,
    filename,
    documentId,
    signal,
  }: ParsePdfInput): Promise<DocumentIntelligenceResponse> => {
    if (baseUrl === undefined || baseUrl === '') {
      throw new DocumentIntelligenceError('not_configured', 'DOCUMENT_INTELLIGENCE_URL is not configured')
    }
    if (data.byteLength === 0) {
      throw new DocumentIntelligenceError('too_large', 'document is empty')
    }
    if (data.byteLength > maxFileSizeBytes) {
      throw new DocumentIntelligenceError(
        'too_large',
        `document exceeds the ${config.maxFileSizeMb} MiB limit`,
      )
    }

    const form = new FormData()
    form.append('file', new Blob([data], { type: 'application/pdf' }), filename)
    form.append('document_id', documentId)

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, config.timeoutMs)
    const onExternalAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onExternalAbort, { once: true })

    const startedAt = Date.now()
    try {
      const response = await fetch(`${baseUrl}/documents/parse`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      })

      if (response.status === 413) {
        throw new DocumentIntelligenceError('too_large', 'service rejected the document size')
      }
      if (!response.ok) {
        throw new DocumentIntelligenceError(
          'upstream_error',
          `service responded with HTTP ${response.status}`,
          response.status,
        )
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new DocumentIntelligenceError('invalid_response', 'response is not valid JSON')
      }

      const parsed = DocumentIntelligenceResponseSchema.safeParse(payload)
      if (!parsed.success) {
        throw new DocumentIntelligenceError(
          'invalid_response',
          'response does not match the document contract',
        )
      }
      if (parsed.data.documentId !== documentId) {
        throw new DocumentIntelligenceError(
          'invalid_response',
          'response documentId does not match the request',
        )
      }

      config.logger.info(
        {
          documentId,
          status: parsed.data.status,
          pageCount: parsed.data.document.pageCount,
          durationMs: Date.now() - startedAt,
        },
        'document_intelligence_parsed',
      )
      return parsed.data
    } catch (error) {
      if (error instanceof DocumentIntelligenceError) {
        config.logger.warn(
          {
            documentId,
            kind: error.kind,
            upstreamStatus: error.upstreamStatus,
            durationMs: Date.now() - startedAt,
          },
          'document_intelligence_failed',
        )
        throw error
      }
      if (timedOut || isAbortError(error)) {
        const failure = new DocumentIntelligenceError(
          timedOut ? 'timeout' : 'unavailable',
          timedOut ? 'request timed out' : 'request aborted',
        )
        config.logger.warn(
          { documentId, kind: failure.kind, durationMs: Date.now() - startedAt },
          'document_intelligence_failed',
        )
        throw failure
      }
      const failure = new DocumentIntelligenceError('unavailable', 'service is unreachable')
      config.logger.warn(
        { documentId, kind: failure.kind, durationMs: Date.now() - startedAt },
        'document_intelligence_failed',
      )
      throw failure
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  return {
    enabled: baseUrl !== undefined && baseUrl !== '',
    maxFileSizeBytes,
    parsePdf,
  }
}
