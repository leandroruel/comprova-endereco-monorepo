import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentIntelligenceResponse } from '@comprova/contracts'
import {
  DocumentIntelligenceError,
  type DocumentIntelligenceClient,
} from '../document-intelligence/client.js'
import type { DebugTraceSink } from '../debug-trace.js'

const unpdf = vi.hoisted(() => ({
  getDocumentProxy: vi.fn(),
  extractImages: vi.fn(),
  extractText: vi.fn(),
  renderPageAsImage: vi.fn(),
}))

const zxing = vi.hoisted(() => ({
  prepareZXingModule: vi.fn(async () => undefined),
  readBarcodes: vi.fn(async (): Promise<{ isValid: boolean; text: string }[]> => []),
}))

vi.mock('unpdf', () => unpdf)
vi.mock('zxing-wasm/reader', () => zxing)

const NF3E_KEY = '35261012345678000199660010000000011000000015'
const NF3E_URL = `https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode?chNFe=${NF3E_KEY}&nVersao=4&tpAmb=1`

const fakePdf = (numPages: number) => ({
  numPages,
  getPage: vi.fn(async () => ({ getViewport: () => ({ width: 612, height: 792 }) })),
  loadingTask: { destroy: vi.fn(async () => undefined) },
})

const raster = {
  key: 'img-1',
  width: 1,
  height: 1,
  channels: 4,
  data: new Uint8ClampedArray([0, 0, 0, 255]),
}

const MARKER_TEXT = [
  'Titular: Maria da Silva',
  'Endereço: Rua das Flores, 123, Apto 45',
  'Bairro: Centro',
  'Cidade: São Paulo',
  'UF: SP',
  'CEP: 01001-000',
].join('\n')

const diResponse = (overrides: Partial<DocumentIntelligenceResponse> = {}): DocumentIntelligenceResponse => ({
  documentId: 'analysis',
  status: 'completed',
  document: { mimeType: 'application/pdf', pageCount: 1, sizeBytes: 3 },
  content: { text: MARKER_TEXT },
  pages: [{ pageNumber: 1, width: 612, height: 792, elements: [] }],
  metadata: {
    processor: 'marker',
    processorVersion: '2.1.0',
    processingTimeMs: 10,
    contractVersion: '1.0',
  },
  warnings: [],
  errorCode: null,
  errorMessage: null,
  ...overrides,
})

const client = (
  parsePdf: DocumentIntelligenceClient['parsePdf'],
  enabled = true,
): DocumentIntelligenceClient => ({
  enabled,
  maxFileSizeBytes: 30 * 1024 * 1024,
  parsePdf,
})

const analyzeWith = async (
  marker: DocumentIntelligenceClient | null,
  localText: string,
  trace?: DebugTraceSink,
) => {
  unpdf.extractText.mockResolvedValue({ text: localText, totalPages: 1 })
  const { makeDocumentAnalyzer } = await import('./index.js')
  return makeDocumentAnalyzer({
    now: () => new Date('2026-10-22T12:00:00.000Z'),
    documentIntelligence: marker,
    ...(trace === undefined ? {} : { trace }),
  }).analyze({ data: new Uint8Array([1, 2, 3]), contentType: 'application/pdf' })
}

describe('análise com fallback para o Marker (F1.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    unpdf.getDocumentProxy.mockResolvedValue(fakePdf(1))
    unpdf.extractImages.mockResolvedValue([])
    unpdf.renderPageAsImage.mockResolvedValue(new Uint8Array([1]))
    zxing.readBarcodes.mockResolvedValue([])
  })

  it('camada textual suficiente: usa local e NÃO chama o Marker', async () => {
    const parsePdf = vi.fn(async () => diResponse())
    const result = await analyzeWith(client(parsePdf), MARKER_TEXT)

    expect(parsePdf).not.toHaveBeenCalled()
    expect(result.status).toBe('completed')
    expect(result.provenance).toEqual({ provider: 'local' })
    expect(result.address.status).toBe('extracted')
  })

  it('PDF escaneado (sem camada): usa OCR do Marker e registra a proveniência', async () => {
    const parsePdf = vi.fn(async () => diResponse())
    const result = await analyzeWith(client(parsePdf), '')

    expect(parsePdf).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('completed')
    expect(result.provenance).toMatchObject({
      provider: 'marker',
      markerVersion: '2.1.0',
      pages: 1,
      processingTimeMs: 10,
    })
    expect(result.address.value?.cep).toBe('01001000')
    expect(result.holder.value?.name).toBe('Maria da Silva')
  })

  it('Marker indisponível + camada insuficiente: fallback local com limitação observável', async () => {
    const parsePdf = vi.fn(async () => {
      throw new DocumentIntelligenceError('unavailable', 'service down')
    })
    const codes: string[] = []
    const result = await analyzeWith(client(parsePdf), '', (event) => codes.push(event.code))

    expect(result.status).toBe('inconclusive')
    expect(result.errorCodes).toContain('NO_TEXT_LAYER')
    expect(result.errorCodes).toContain('MARKER_UNAVAILABLE')
    expect(result.provenance).toMatchObject({ provider: 'local', fallback: true })
    expect(codes).toContain('marker.fallback')
    expect(codes).toContain('text.fallback')
  })

  it('timeout do Marker + camada insuficiente: fallback local', async () => {
    const parsePdf = vi.fn(async () => {
      throw new DocumentIntelligenceError('timeout', 'too slow')
    })
    const result = await analyzeWith(client(parsePdf), '')

    expect(result.status).toBe('inconclusive')
    expect(result.errorCodes).toContain('MARKER_TIMEOUT')
    expect(result.provenance).toMatchObject({ provider: 'local', fallback: true })
  })

  it('capacidade esgotada (busy/429) é reportada como MARKER_BUSY, não MARKER_UNAVAILABLE', async () => {
    const parsePdf = vi.fn(async () => {
      throw new DocumentIntelligenceError('busy', 'capacity exhausted')
    })
    const result = await analyzeWith(client(parsePdf), '')

    expect(result.errorCodes).toContain('MARKER_BUSY')
    expect(result.errorCodes).not.toContain('MARKER_UNAVAILABLE')
  })

  it('resultado parcial do Marker (texto curto): inconclusivo com código de OCR', async () => {
    const parsePdf = vi.fn(async () => diResponse({ content: { text: 'ab' } }))
    const result = await analyzeWith(client(parsePdf), '')

    expect(result.status).toBe('inconclusive')
    expect(result.errorCodes).toContain('NO_TEXT_LAYER')
    expect(result.errorCodes).toContain('OCR_NO_USABLE_TEXT')
  })

  it('falha de parsing do Marker: fallback local com código de parsing', async () => {
    const parsePdf = vi.fn(async () => diResponse({ status: 'failed', errorCode: 'X', errorMessage: 'boom' }))
    const result = await analyzeWith(client(parsePdf), '')

    expect(result.status).toBe('inconclusive')
    expect(result.errorCodes).toContain('MARKER_PARSING_FAILED')
  })

  it('não chama o Marker para documento acima do limite de páginas', async () => {
    unpdf.getDocumentProxy.mockResolvedValue(fakePdf(51))
    const parsePdf = vi.fn(async () => diResponse())
    const result = await analyzeWith(client(parsePdf), '')

    expect(parsePdf).not.toHaveBeenCalled()
    expect(result.errorCodes).toContain('TOO_MANY_PAGES')
  })

  it('sem cliente configurado: mantém o comportamento anterior (apenas local)', async () => {
    const result = await analyzeWith(null, '')

    expect(result.status).toBe('inconclusive')
    expect(result.errorCodes).toEqual(['NO_TEXT_LAYER'])
    expect(result.provenance).toBeUndefined()
  })

  it('preserva a referência fiscal do QR mesmo quando o Marker fornece o texto', async () => {
    unpdf.extractImages.mockResolvedValue([raster])
    zxing.readBarcodes.mockResolvedValue([{ isValid: true, text: NF3E_URL }])
    const parsePdf = vi.fn(async () => diResponse())
    const result = await analyzeWith(client(parsePdf), '')

    expect(result.fiscalReference).toMatchObject({
      status: 'found',
      issuer: 'SVRS',
      documentId: NF3E_KEY,
      method: 'qr_code',
    })
    expect(result.provenance).toMatchObject({ provider: 'marker' })
  })

  it('complementa campos ausentes do texto com tabelas do Marker', async () => {
    const parsePdf = vi.fn(async () =>
      diResponse({
        content: { text: 'CONTA DE ENERGIA\nCompetência: 01/10/2026' },
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
                table: {
                  headers: ['Unidade Consumidora'],
                  rows: [['123456789']],
                  cells: [],
                  bbox: null,
                },
                imageRef: null,
                metadata: {},
              },
            ],
          },
        ],
      }),
    )
    const result = await analyzeWith(client(parsePdf), '')

    expect(result.status).toBe('completed')
    expect(result.address.status).toBe('not_extracted')
    expect(result.provenance).toMatchObject({ provider: 'marker' })
  })
})
