import type { Logger } from '@comprova/observability'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  makeDocumentIntelligenceClient,
  type DocumentIntelligenceClient,
} from '../document-intelligence/client.js'
import { makeMarkerAdapter } from './marker.js'

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
}

const validPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  documentId: 'doc-1',
  status: 'completed',
  document: { mimeType: 'application/pdf', pageCount: 1, sizeBytes: 3 },
  content: { text: 'Titular: Maria da Silva', markdown: 'Titular: Maria da Silva' },
  pages: [
    {
      pageNumber: 1,
      width: 612,
      height: 792,
      elements: [
        {
          id: 'el-1',
          type: 'text',
          text: 'Titular: Maria da Silva',
          bbox: { x1: 1, y1: 1, x2: 2, y2: 2 },
          confidence: null,
          table: null,
          imageRef: null,
          metadata: {},
        },
      ],
    },
  ],
  metadata: {
    processor: 'marker',
    processorVersion: '2.1.0',
    processingTimeMs: 12,
    contractVersion: '1.0',
  },
  warnings: [],
  errorCode: null,
  errorMessage: null,
  ...overrides,
})

const client = (): DocumentIntelligenceClient =>
  makeDocumentIntelligenceClient({
    url: 'http://document-intelligence:8000',
    timeoutMs: 1_000,
    maxFileSizeMb: 30,
    logger: silentLogger,
  })

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

const input = { data: new Uint8Array([1, 2, 3]), filename: 'a.pdf', documentId: 'doc-1' }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MarkerAdapter', () => {
  it('extrai texto e metadados do contrato válido', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(validPayload())),
    )
    const adapter = makeMarkerAdapter(client())

    const result = await adapter.parse(input)

    expect(result.text).toBe('Titular: Maria da Silva')
    expect(result.pages).toBe(1)
    expect(result.markerVersion).toBe('2.1.0')
    expect(result.processingTimeMs).toBe(12)
    expect(result.tables).toEqual([])
  })

  it('coleta tabelas dos elementos', async () => {
    const table = {
      headers: ['UNIDADE CONSUMIDORA'],
      rows: [['123456789']],
      cells: [],
      bbox: null,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          validPayload({
            content: { text: 'Tabela de consumo' },
            pages: [
              {
                pageNumber: 1,
                width: 612,
                height: 792,
                elements: [
                  {
                    id: 'table-1',
                    type: 'table',
                    text: null,
                    bbox: null,
                    confidence: null,
                    table,
                    imageRef: null,
                    metadata: {},
                  },
                ],
              },
            ],
          }),
        ),
      ),
    )
    const adapter = makeMarkerAdapter(client())

    const result = await adapter.parse(input)

    expect(result.tables).toHaveLength(1)
    expect(result.tables[0]?.headers).toEqual(['UNIDADE CONSUMIDORA'])
    expect(result.text).toBe('Tabela de consumo')
  })

  it('usa texto das páginas quando content.text está em branco', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          validPayload({
            content: { text: '' },
            pages: [
              {
                pageNumber: 1,
                width: 612,
                height: 792,
                elements: [
                  {
                    id: 'el-1',
                    type: 'text',
                    text: 'Texto extraído das páginas',
                    bbox: { x1: 1, y1: 1, x2: 2, y2: 2 },
                    confidence: null,
                    table: null,
                    imageRef: null,
                    metadata: {},
                  },
                ],
              },
            ],
          }),
        ),
      ),
    )
    const adapter = makeMarkerAdapter(client())

    const result = await adapter.parse(input)

    expect(result.text).toBe('Texto extraído das páginas')
  })

  it('lança no_text quando nem content.text nem páginas têm texto', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          validPayload({
            content: { text: '   ' },
            pages: [{ pageNumber: 1, width: 612, height: 792, elements: [] }],
          }),
        ),
      ),
    )
    const adapter = makeMarkerAdapter(client())

    await expect(adapter.parse(input)).rejects.toMatchObject({ kind: 'no_text' })
  })

  it('mapeia status failed do serviço para parsing_failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(validPayload({ status: 'failed', errorCode: 'MARKER_FAILED', errorMessage: 'boom' })),
      ),
    )
    const adapter = makeMarkerAdapter(client())

    await expect(adapter.parse(input)).rejects.toMatchObject({ kind: 'parsing_failed' })
  })

  it('mapeia ausência de texto para no_text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(validPayload({ content: { text: '   ' }, pages: [] }))),
    )
    const adapter = makeMarkerAdapter(client())

    await expect(adapter.parse(input)).rejects.toMatchObject({ kind: 'no_text' })
  })

  it('mapeia HTTP 4xx para unsupported', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad', { status: 400 })),
    )
    const adapter = makeMarkerAdapter(client())

    await expect(adapter.parse(input)).rejects.toMatchObject({ kind: 'unsupported' })
  })

  it('mapeia HTTP 422 (criptografado/limite) para unsupported', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('encrypted', { status: 422 })),
    )
    const adapter = makeMarkerAdapter(client())

    await expect(adapter.parse(input)).rejects.toMatchObject({ kind: 'unsupported' })
  })

  it('mapeia HTTP 5xx para unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('oops', { status: 500 })),
    )
    const adapter = makeMarkerAdapter(client())

    await expect(adapter.parse(input)).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('mapeia 503 (não pronto) para unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not ready', { status: 503 })),
    )
    const adapter = makeMarkerAdapter(client())

    await expect(adapter.parse(input)).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('mapeia 429 (capacidade) para busy, não unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('busy', { status: 429 })),
    )
    const adapter = makeMarkerAdapter(client())

    await expect(adapter.parse(input)).rejects.toMatchObject({ kind: 'busy' })
  })

  it('mapeia timeout do cliente para timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, init: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          }),
      ),
    )
    const adapter = makeMarkerAdapter(
      makeDocumentIntelligenceClient({
        url: 'http://document-intelligence:8000',
        timeoutMs: 5,
        maxFileSizeMb: 30,
        logger: silentLogger,
      }),
    )

    await expect(adapter.parse(input)).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('mapeia erro de conexão para unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    const adapter = makeMarkerAdapter(client())

    await expect(adapter.parse(input)).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('mapeia resposta fora do contrato para parsing_failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ documentId: 'doc-1' })),
    )
    const adapter = makeMarkerAdapter(client())

    await expect(adapter.parse(input)).rejects.toMatchObject({ kind: 'parsing_failed' })
  })

  it('emite trace dos passos principais sem vazar conteúdo integral', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(validPayload())),
    )
    const adapter = makeMarkerAdapter(client())
    const codes: string[] = []

    await adapter.parse(input, (event) => {
      codes.push(event.code)
    })

    expect(codes).toContain('marker.call')
    expect(codes).toContain('marker.success')
  })

  it('não chama o serviço quando a URL não está configurada', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const disabled = makeDocumentIntelligenceClient({
      url: undefined,
      timeoutMs: 1_000,
      maxFileSizeMb: 30,
      logger: silentLogger,
    })
    const adapter = makeMarkerAdapter(disabled)

    await expect(adapter.parse(input)).rejects.toMatchObject({ kind: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
