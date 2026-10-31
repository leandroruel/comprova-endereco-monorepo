import type { Logger } from '@comprova/observability'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DocumentIntelligenceError,
  makeDocumentIntelligenceClient,
  type DocumentIntelligenceClientConfig,
} from '../../src/services/document-intelligence-client.js'

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
}

const config = (
  overrides: Partial<DocumentIntelligenceClientConfig> = {},
): DocumentIntelligenceClientConfig => ({
  url: 'http://document-intelligence:8000',
  timeoutMs: 1_000,
  maxFileSizeMb: 30,
  logger: silentLogger,
  ...overrides,
})

const validPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  documentId: 'doc-1',
  status: 'completed',
  document: { mimeType: 'application/pdf', pageCount: 1, sizeBytes: 3 },
  content: { text: 'abc', markdown: 'abc' },
  pages: [{ pageNumber: 1, elements: [], width: 612, height: 792 }],
  metadata: {
    processor: 'marker',
    processorVersion: '2.1.0',
    processingTimeMs: 5,
    contractVersion: '1.0',
  },
  warnings: [],
  errorCode: null,
  errorMessage: null,
  ...overrides,
})

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('document intelligence client', () => {
  it('falha fechado quando a URL não está configurada', async () => {
    const client = makeDocumentIntelligenceClient(config({ url: undefined }))
    expect(client.enabled).toBe(false)
    await expect(
      client.parsePdf({ data: Buffer.from('%PDF-1.4'), filename: 'a.pdf', documentId: 'doc-1' }),
    ).rejects.toMatchObject({ kind: 'not_configured' })
  })

  it('rejeita arquivo acima do limite sem chamar o serviço', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const client = makeDocumentIntelligenceClient(config({ maxFileSizeMb: 1 }))
    await expect(
      client.parsePdf({
        data: Buffer.alloc(2 * 1024 * 1024),
        filename: 'a.pdf',
        documentId: 'doc-1',
      }),
    ).rejects.toMatchObject({ kind: 'too_large' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('envia o PDF e o documentId e devolve o contrato validado', async () => {
    let capturedUrl: string | undefined
    let capturedForm: FormData | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        capturedUrl = url
        capturedForm = init.body as FormData
        return jsonResponse(validPayload())
      }),
    )

    const client = makeDocumentIntelligenceClient(config())
    const result = await client.parsePdf({
      data: Buffer.from('%PDF-1.4'),
      filename: 'fatura.pdf',
      documentId: 'doc-1',
    })

    expect(capturedUrl).toBe('http://document-intelligence:8000/documents/parse')
    expect(capturedForm?.get('document_id')).toBe('doc-1')
    expect(capturedForm?.get('file')).toBeInstanceOf(Blob)
    expect(result.document.pageCount).toBe(1)
    expect(result.metadata.processor).toBe('marker')
  })

  it('normaliza barra final da URL', async () => {
    let capturedUrl: string | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrl = url
        return jsonResponse(validPayload())
      }),
    )
    const client = makeDocumentIntelligenceClient(config({ url: 'http://di:8000///' }))
    await client.parsePdf({ data: Buffer.from('%PDF-1.4'), filename: 'a.pdf', documentId: 'doc-1' })
    expect(capturedUrl).toBe('http://di:8000/documents/parse')
  })

  it('mapeia status HTTP de erro para upstream_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('failure', { status: 502 })),
    )
    const client = makeDocumentIntelligenceClient(config())
    await expect(
      client.parsePdf({ data: Buffer.from('%PDF-1.4'), filename: 'a.pdf', documentId: 'doc-1' }),
    ).rejects.toMatchObject({ kind: 'upstream_error', upstreamStatus: 502 })
  })

  it('mapeia 413 para too_large', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('too large', { status: 413 })),
    )
    const client = makeDocumentIntelligenceClient(config())
    await expect(
      client.parsePdf({ data: Buffer.from('%PDF-1.4'), filename: 'a.pdf', documentId: 'doc-1' }),
    ).rejects.toMatchObject({ kind: 'too_large' })
  })

  it('rejeita resposta que não é JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nao eh json', { status: 200 })),
    )
    const client = makeDocumentIntelligenceClient(config())
    await expect(
      client.parsePdf({ data: Buffer.from('%PDF-1.4'), filename: 'a.pdf', documentId: 'doc-1' }),
    ).rejects.toMatchObject({ kind: 'invalid_response' })
  })

  it('rejeita resposta fora do contrato', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ documentId: 'doc-1' })),
    )
    const client = makeDocumentIntelligenceClient(config())
    await expect(
      client.parsePdf({ data: Buffer.from('%PDF-1.4'), filename: 'a.pdf', documentId: 'doc-1' }),
    ).rejects.toMatchObject({ kind: 'invalid_response' })
  })

  it('rejeita documentId divergente', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(validPayload({ documentId: 'outro' }))),
    )
    const client = makeDocumentIntelligenceClient(config())
    await expect(
      client.parsePdf({ data: Buffer.from('%PDF-1.4'), filename: 'a.pdf', documentId: 'doc-1' }),
    ).rejects.toMatchObject({ kind: 'invalid_response' })
  })

  it('mapeia erro de conexão para unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    const client = makeDocumentIntelligenceClient(config())
    await expect(
      client.parsePdf({ data: Buffer.from('%PDF-1.4'), filename: 'a.pdf', documentId: 'doc-1' }),
    ).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('mapeia estouro de timeout para timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, init: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'))
            })
          }),
      ),
    )
    const client = makeDocumentIntelligenceClient(config({ timeoutMs: 5 }))
    await expect(
      client.parsePdf({ data: Buffer.from('%PDF-1.4'), filename: 'a.pdf', documentId: 'doc-1' }),
    ).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('propaga erro tipado sem vazar detalhes internos', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('segredo', { status: 500 })),
    )
    const client = makeDocumentIntelligenceClient(config())
    const error = await client
      .parsePdf({ data: Buffer.from('%PDF-1.4'), filename: 'a.pdf', documentId: 'doc-1' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DocumentIntelligenceError)
    expect((error as Error).message).not.toContain('segredo')
  })
})
