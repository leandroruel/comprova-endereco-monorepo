import { describe, expect, it, vi } from 'vitest'

const unpdf = vi.hoisted(() => ({
  extractImages: vi.fn(async () => []),
  renderPageAsImage: vi.fn(async () => new Uint8Array([1])),
}))

const zxing = vi.hoisted(() => ({
  prepareZXingModule: vi.fn(async () => undefined),
  readBarcodes: vi.fn(async () => []),
}))

vi.mock('unpdf', () => unpdf)
vi.mock('zxing-wasm/reader', () => zxing)

const fakePdf = {
  numPages: 1,
  getPage: vi.fn(async () => ({ getViewport: () => ({ width: 612, height: 792 }) })),
}

describe('F2.2b — falhas da renderização vetorial', () => {
  it('preserva QR_DECODER_UNAVAILABLE no caminho de página renderizada', async () => {
    zxing.prepareZXingModule.mockRejectedValue(new Error('wasm unavailable'))

    const { extractFiscalReferenceFromPdf } = await import('./reference.js')
    const reference = await extractFiscalReferenceFromPdf(fakePdf as never)

    expect(reference.status).toBe('inconclusive')
    expect(reference.errorCodes).toEqual(['QR_DECODER_UNAVAILABLE'])
  })
})
