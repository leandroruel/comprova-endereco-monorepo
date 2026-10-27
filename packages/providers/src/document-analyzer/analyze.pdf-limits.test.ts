import { beforeEach, describe, expect, it, vi } from 'vitest'

const unpdf = vi.hoisted(() => ({
  getDocumentProxy: vi.fn(),
  extractImages: vi.fn(),
  extractText: vi.fn(),
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

  it.each([
    ['chave isolada no texto', `Chave de acesso: ${NF3E_KEY}`],
    ['URL de autorizador sem chave', 'Consulta: https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode'],
  ])('%s não dispensa o QR (referência textual incompleta)', async (_name, text) => {
    // Um DANFE pode imprimir só a chave ou só a URL de consulta no texto; sem
    // autorizador (chave isolada) ou sem documento (URL sem chave) a referência
    // não é consultável, então o QR legível tem precedência.
    unpdf.extractText.mockResolvedValue({ text, totalPages: 1 })
    unpdf.extractImages.mockResolvedValue([raster])
    zxing.readBarcodes.mockResolvedValue([{ isValid: true, text: NF3E_URL }])
    unpdf.getDocumentProxy.mockResolvedValue(fakePdf(1))
    const { analyzeDocument } = await import('./analyze.js')

    const result = await analyzeDocument(
      { data: new Uint8Array([1, 2, 3]), contentType: 'application/pdf' },
      new Date('2026-10-22T12:00:00.000Z'),
    )

    expect(result.fiscalReference).toMatchObject({
      status: 'found',
      issuer: 'SVRS',
      documentId: NF3E_KEY,
      method: 'qr_code',
    })
  })
})
