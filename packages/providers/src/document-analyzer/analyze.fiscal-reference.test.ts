import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { extractFiscalReferenceFromText } from '../fiscal/reference.js'
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
