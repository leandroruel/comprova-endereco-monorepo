import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { extractFiscalReferenceFromArtifact, extractFiscalReferenceFromText } from '../fiscal/reference.js'
import { analyzeDocument } from './analyze.js'
import { pdfWithText } from './test-pdf.js'

/**
 * F1.2/F2.2a — a referência fiscal sai do próprio PDF, de forma determinística:
 *
 *   PDF → texto (PDF.js) ou QR raster → `extractFiscalReferenceFromText`/
 *   `extractFiscalReferenceFromPdf` → `fiscalReference`
 *
 * Nenhum caminho aqui chama VLM/LLM, renderiza página ou busca a URL. O teste
 * usa a fixture NF3e real (`nf3e-qr.pdf`, QR raster) e um PDF com camada
 * textual para o caminho novo — a fixture existente não tem texto.
 */

const NF3E_KEY = '35261012345678000199660010000000011000000015'
const NF3E_URL = `https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode?chNFe=${NF3E_KEY}&nVersao=4&tpAmb=1`
const ANALYZED_AT = new Date('2026-10-22T12:00:00.000Z')

const fixture = (name: string): Uint8Array => {
  const buffer = readFileSync(new URL(`../fiscal/__fixtures__/${name}`, import.meta.url))
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

/**
 * PDF com camada textual real (Helvetica). Não é uma fixture NF3e: existe para
 * exercitar o caminho textual do analyzer, que a fixture raster não cobre. A
 * fonte de 7pt mantém a URL inteira dentro da página (o PDF.js trunca texto que
 * ultrapassa a largura).
 */
const textPdf = (lines: readonly string[]): Uint8Array => new Uint8Array(pdfWithText(lines, { fontSize: 7 }))

const VECTOR_QR = [
  '1111111010011111100011100100001111111',
  '1000001001100011101000101010001000001',
  '1011101000101100101101010100101011101',
  '1011101000001010101011101110101011101',
  '1011101001010110011010110110101011101',
  '1000001000101101011000011110101000001',
  '1111111010101010101010101010101111111',
  '0000000010110101001110110101100000000',
  '1101101001110011001101111010101000001',
  '0010100011001111101010000111100010010',
  '1010011111110111111011011101000011111',
  '1010100000011010111001111001010110100',
  '1000101111011111111110101001001101011',
  '1001000100000101001110110111110011110',
  '1001101111111100010101100011001000011',
  '1111110001110100110000011011010010101',
  '0001101001100100001010111110001001111',
  '1010010001011101011110100011000101000',
  '0011011111010110011111110011001110001',
  '0110010111101000011111010101100011001',
  '1010011111001100001101110011111011011',
  '0010110000100111000101011011010111110',
  '0110111001101011111001010001011001001',
  '0010100011100001110001110011010001111',
  '1100011010100110101011111010101001001',
  '1010000101001010000100010011010011010',
  '1111111100100011011100001011001011011',
  '1001100011101111100101000001110101101',
  '1011011000111000100100011101111111110',
  '0000000011110000110110000011100011110',
  '1111111001001110001110010110101010101',
  '1000001001110101011110110101100010001',
  '1011101011110101011100111011111111011',
  '1011101011101100100010110000001001010',
  '1011101001110100101010011101010110011',
  '1000001010111101110010001001000001111',
  '1111111011011100101011111100110110001',
] as const

const SECOND_VECTOR_QR = [
  '1111111010011111110001100100001111111',
  '1000001001100011101100101010001000001',
  '1011101000101100101001010100101011101',
  '1011101000001010101011101110101011101',
  '1011101001010110011010110110101011101',
  '1000001000101101011000011110101000001',
  '1111111010101010101010101010101111111',
  '0000000010110101001110110101100000000',
  '1101101001110011001101111010101000001',
  '0001100101001111101010000111100010010',
  '1111011110010111111011011101000011111',
  '0101110001011010111001111001010110100',
  '0101001110111111111110101001001101011',
  '0011100000100101011110110111110011110',
  '1010001100011100010101100011001000011',
  '1000110100110100101010011011010010101',
  '1110111111100100001110111110001001111',
  '1000110111011101011010100011000101000',
  '0001101000010110011011110011001110001',
  '0010100111001000011111010101100011001',
  '1101001100001100001101110011111011011',
  '1000100011100111000101011011010111110',
  '0011011110001011111001010001011001001',
  '1010000100100001110001110011010001111',
  '1100101101100110101010111010101001001',
  '1110010010001010000001110011010011010',
  '1101111110000011011111001011001011011',
  '1000100000001111100101000001110101101',
  '1010001001111000100000011101111111110',
  '0000000011010000110111000011100011110',
  '1111111001101110001110110110101010101',
  '1000001000010101011110010101100010001',
  '1011101010010101011100111011111111011',
  '1011101011101100100011010000001001010',
  '1011101001110100101011010111010110011',
  '1000001011111101110000001001000001111',
  '1111111011011100101111011100110110001',
] as const

const INVALID_VECTOR_QR = VECTOR_QR.map((row, index) => (index === 0 ? `0${row.slice(1)}` : row))

const vectorQrPdf = (): Uint8Array =>
  new Uint8Array(pdfWithText(['Comprovante de energia'], { vectorQr: VECTOR_QR }))

const rasterAndVectorPdf = (vectorQrs: readonly (readonly string[])[]): Uint8Array =>
  new Uint8Array(
    pdfWithText(['Comprovante de energia'], {
      rasterJpeg: { data: fixture('qr-nf3e.jpg'), width: 270, height: 270 },
      vectorQrs: vectorQrs.map((matrix, index) => ({ matrix, x: index === 0 ? 300 : 40 })),
    }),
  )

const nf3eText = (): Uint8Array =>
  textPdf([
    'DANFE - Documento Auxiliar da Nota Fiscal de Energia Eletrica',
    `Chave de acesso: ${NF3E_KEY}`,
    `Consulta via leitor de QR Code: ${NF3E_URL}`,
    'Emitente: Empresa Exemplo Ltda',
  ])

const analyze = (data: Uint8Array) => analyzeDocument({ data, contentType: 'application/pdf' }, ANALYZED_AT)

describe('document analyzer — referência fiscal determinística (sem VLM)', () => {
  it('extrai a referência da fixture NF3e real (QR raster embutido)', async () => {
    const result = await analyze(fixture('nf3e-qr.pdf'))

    expect(result.fiscalReference).toMatchObject({
      status: 'found',
      source: 'nf3e',
      issuer: 'SVRS',
      uf: 'SP',
      documentId: NF3E_KEY,
      method: 'qr_code',
    })
    expect(result.fiscalReference?.errorCodes).toEqual([])
  })

  it('extrai a referência da camada textual do PDF', async () => {
    const result = await analyze(nf3eText())

    expect(result.status).toBe('completed')
    expect(result.fiscalReference).toMatchObject({
      status: 'found',
      source: 'nf3e',
      issuer: 'SVRS',
      uf: 'SP',
      documentId: NF3E_KEY,
      method: 'text',
    })
    expect(result.fiscalReference?.errorCodes).toEqual([])
  })

  it('extrai QR desenhado como vetor no PDF', async () => {
    const result = await analyze(vectorQrPdf())

    expect(result.fiscalReference).toMatchObject({
      status: 'found',
      source: 'nf3e',
      issuer: 'SVRS',
      uf: 'SP',
      documentId: NF3E_KEY,
      method: 'qr_code',
    })
    expect(result.fiscalReference?.errorCodes).toEqual([])
  })

  it('deduplica o mesmo QR encontrado na imagem embutida e na renderização', async () => {
    const result = await analyze(rasterAndVectorPdf([VECTOR_QR]))

    expect(result.fiscalReference).toMatchObject({
      status: 'found',
      source: 'nf3e',
      documentId: NF3E_KEY,
      limitations: [],
    })
    expect(result.fiscalReference?.errorCodes).toEqual([])
  })

  it('deduplica antes de maxSymbols quando a mesma referência aparece três vezes', async () => {
    const reference = await extractFiscalReferenceFromArtifact(
      { data: rasterAndVectorPdf([VECTOR_QR, VECTOR_QR]), contentType: 'application/pdf' },
      { maxSymbols: 2 },
    )

    expect(reference).toMatchObject({
      status: 'found',
      documentId: NF3E_KEY,
      limitations: [],
    })
  })

  it('não escolhe entre QR raster e vetorial com referências diferentes', async () => {
    const result = await analyze(rasterAndVectorPdf([SECOND_VECTOR_QR]))

    expect(result.fiscalReference?.status).toBe('unsupported')
    expect(result.fiscalReference?.errorCodes).toContain('AMBIGUOUS_REFERENCE')
    expect(result.fiscalReference?.documentId).toBeNull()
  })

  it('trata múltiplos QR vetoriais distintos como ambíguos', async () => {
    const result = await analyze(
      new Uint8Array(
        pdfWithText(['Comprovante de energia'], {
          vectorQrs: [
            { matrix: VECTOR_QR, x: 300 },
            { matrix: SECOND_VECTOR_QR, x: 40 },
          ],
        }),
      ),
    )

    expect(result.fiscalReference?.status).toBe('unsupported')
    expect(result.fiscalReference?.errorCodes).toContain('AMBIGUOUS_REFERENCE')
  })

  it('não transforma QR vetorial inválido em referência fiscal', async () => {
    const result = await analyze(
      new Uint8Array(pdfWithText(['Comprovante de energia'], { vectorQr: INVALID_VECTOR_QR })),
    )

    expect(result.fiscalReference?.status).not.toBe('found')
    expect(result.fiscalReference?.documentId).toBeNull()
  })

  it('ignora URL não fiscal e completa a URL de consulta com a chave impressa', async () => {
    const issuerOnlyUrl = 'https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode'
    const result = await analyze(
      textPdf([
        'Site do emitente: https://evil.example/pagina',
        `Chave de acesso: ${NF3E_KEY}`,
        `Consulta: ${issuerOnlyUrl}`,
      ]),
    )

    expect(result.fiscalReference).toMatchObject({
      status: 'found',
      source: 'nf3e',
      issuer: 'SVRS',
      uf: 'SP',
      documentId: NF3E_KEY,
      method: 'text',
    })
  })

  it('preserva o documentId exatamente como está no documento', async () => {
    for (const data of [fixture('nf3e-qr.pdf'), nf3eText()]) {
      const result = await analyze(data)
      // A chave do PDF, sem normalização, truncamento ou dígito calculado.
      expect(result.fiscalReference?.documentId).toBe(NF3E_KEY)
      expect(result.fiscalReference?.fingerprint).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  it('extrai a URL fiscal de forma determinística e a redige na persistência', async () => {
    // A URL é reconhecida antes da projeção persistida…
    const reference = extractFiscalReferenceFromText(`Consulta: ${NF3E_URL}.`)
    expect(reference).toMatchObject({
      status: 'found',
      source: 'nf3e',
      issuer: 'SVRS',
      documentId: NF3E_KEY,
      method: 'text',
    })
    expect(reference.url).toBe(NF3E_URL)

    // …mas o resultado do analyzer nunca persiste a URL (política existente).
    const result = await analyze(nf3eText())
    expect(result.fiscalReference?.url).toBeNull()
    expect(result.fiscalReference?.documentId).toBe(NF3E_KEY)
  })

  it('PDF sem referência não vira found nem falha', async () => {
    const result = await analyze(
      textPdf(['Comprovante de residencia', 'Rua das Flores, 123 - Centro', 'Sao Paulo/SP']),
    )

    // No PDF o resultado continua inconclusivo (um QR vetorial não pode ser
    // descartado); no texto, a ausência de evidência é `not_found`.
    expect(result.fiscalReference?.status).not.toBe('found')
    expect(result.fiscalReference?.documentId).toBeNull()
    expect(result.fiscalReference?.fingerprint).toBeNull()
    expect(result.fiscalReference?.errorCodes).toEqual(['PDF_QR_VECTOR_UNSUPPORTED'])
    expect(extractFiscalReferenceFromText('Comprovante de residencia sem referencia fiscal')).toMatchObject({
      status: 'not_found',
      documentId: null,
      errorCodes: [],
    })
  })

  it('rejeita uma chave com formato inválido (DV/modelo/UF)', async () => {
    const invalidKey = `${NF3E_KEY.slice(0, 43)}9`

    expect(extractFiscalReferenceFromText(`Chave de acesso: ${invalidKey}`)).toMatchObject({
      status: 'unsupported',
      errorCodes: ['INVALID_DOCUMENT_ID'],
    })

    const result = await analyze(textPdf([`Chave de acesso: ${invalidKey}`]))
    expect(result.fiscalReference?.status).not.toBe('found')
    expect(result.fiscalReference?.documentId).toBeNull()
  })

  it('não transforma URL externa arbitrária em referência fiscal', async () => {
    expect(extractFiscalReferenceFromText('Acesse https://evil.example/pagina')).toMatchObject({
      status: 'unsupported',
      errorCodes: ['REFERENCE_NOT_RECOGNIZED'],
    })

    const result = await analyze(textPdf(['Acesse https://evil.example/pagina para mais detalhes']))
    expect(result.fiscalReference?.status).not.toBe('found')
    expect(result.fiscalReference?.documentId).toBeNull()
    expect(result.fiscalReference?.url).toBeNull()
  })

  it('é determinístico: duas análises do mesmo PDF produzem a mesma referência', async () => {
    // Bytes novos a cada execução: o PDF.js transfere o buffer para o worker.
    const runs = [() => fixture('nf3e-qr.pdf'), () => nf3eText()]
    for (const load of runs) {
      const first = await analyze(load())
      const second = await analyze(load())
      expect(first.fiscalReference?.status).toBe('found')
      expect(second.fiscalReference).toEqual(first.fiscalReference)
    }
  })
})
