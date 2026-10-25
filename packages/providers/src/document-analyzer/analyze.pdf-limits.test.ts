import { beforeEach, describe, expect, it, vi } from 'vitest'

const unpdf = vi.hoisted(() => ({
  getDocumentProxy: vi.fn(),
  extractImages: vi.fn(),
  extractText: vi.fn(),
}))

const zxing = vi.hoisted(() => ({
  prepareZXingModule: vi.fn(async () => undefined),
  readBarcodes: vi.fn(async () => []),
}))

vi.mock('unpdf', () => unpdf)
vi.mock('zxing-wasm/reader', () => zxing)

const fakePdf = (numPages: number) => ({
  numPages,
  loadingTask: { destroy: vi.fn(async () => undefined) },
})

const raster = {
  key: 'img-1',
  width: 1,
  height: 1,
  channels: 4,
  data: new Uint8ClampedArray([0, 0, 0, 255]),
}

describe('limites e semântica de PDF (F2.2b)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    unpdf.extractImages.mockResolvedValue([])
    unpdf.extractText.mockResolvedValue({ text: '', totalPages: 1 })
  })

  it('valida o limite de páginas antes de decodificar QR ou texto', async () => {
    const pdf = fakePdf(51)
    unpdf.getDocumentProxy.mockResolvedValue(pdf)
    const { analyzeDocument } = await import('./analyze.js')

    const result = await analyzeDocument(
      { data: new Uint8Array([1, 2, 3]), contentType: 'application/pdf' },
      new Date('2026-10-22T12:00:00.000Z'),
    )

    expect(result.status).toBe('inconclusive')
    expect(result.errorCodes).toContain('TOO_MANY_PAGES')
    expect(result.fiscalReference).toMatchObject({
      status: 'inconclusive',
      errorCodes: ['PDF_TOO_MANY_PAGES'],
    })
    expect(unpdf.extractImages).not.toHaveBeenCalled()
    expect(unpdf.extractText).not.toHaveBeenCalled()
    expect(pdf.loadingTask.destroy).toHaveBeenCalledTimes(1)
  })

  it('PDF com raster inspecionado sem QR é inconclusivo, não not_found', async () => {
    unpdf.extractImages.mockResolvedValue([raster])
    const { extractFiscalReferenceFromPdf } = await import('../fiscal/reference.js')

    const reference = await extractFiscalReferenceFromPdf(fakePdf(1) as never)

    expect(reference.status).toBe('inconclusive')
    expect(reference.errorCodes).toEqual(['PDF_QR_VECTOR_UNSUPPORTED'])
  })
})
