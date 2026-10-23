import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { makeDocumentAnalyzer } from './document-analyzer/index.js'

const escapePdf = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

interface PdfOptions {
  readonly compress?: boolean
  readonly withContent?: boolean
}

/**
 * Gera um PDF mínimo válido (xref incluído). É fixture de teste, não um parser:
 * o objetivo é exercitar o contrato do analyzer com um PDF que o PDF.js aceita.
 */
const pdfWithText = (lines: readonly string[], options: PdfOptions = {}): Buffer => {
  const content = `BT\n/F1 12 Tf\n72 720 Td\n${lines
    .map((line) => `(${escapePdf(line)}) Tj\n0 -20 Td\n`)
    .join('')}ET`
  const stream = options.compress
    ? deflateSync(Buffer.from(content, 'latin1'))
    : Buffer.from(content, 'latin1')
  const filter = options.compress ? ' /Filter /FlateDecode' : ''
  const withContent = options.withContent ?? true

  const objects: readonly (string | Buffer)[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    withContent
      ? '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
      : '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
    Buffer.concat([
      Buffer.from(`<< /Length ${stream.length}${filter} >>\nstream\n`, 'latin1'),
      stream,
      Buffer.from('\nendstream', 'latin1'),
    ]),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')]
  const offsets: number[] = []
  let size = chunks[0]?.length ?? 0

  for (const [index, object] of objects.entries()) {
    offsets.push(size)
    const head = Buffer.from(`${index + 1} 0 obj\n`, 'latin1')
    const body = typeof object === 'string' ? Buffer.from(object, 'latin1') : object
    const tail = Buffer.from('\nendobj\n', 'latin1')
    chunks.push(head, body, tail)
    size += head.length + body.length + tail.length
  }

  const xref = Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
      offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`,
    'latin1',
  )
  chunks.push(xref)
  return Buffer.concat(chunks)
}

const analyzerAt = (iso: string) => makeDocumentAnalyzer({ now: () => new Date(iso) })

const fullBill = [
  'CONTA DE ENERGIA',
  'Distribuidora CEMIG - CNPJ 11.222.333/0001-81',
  'Titular: Maria da Silva CPF: 529.982.247-25',
  'CPF: 529.982.247-25',
  'Endereço: Rua das Flores, 123, Apto 45',
  'Bairro: Centro',
  'Cidade: São Paulo',
  'UF: SP',
  'CEP: 01001-000',
  'Data de emissão: 30/09/2026',
  'Competência: 01/10/2026',
]

describe('makeDocumentAnalyzer (F1.2)', () => {
  it('extrai endereço, titular e data de PDF textual', async () => {
    const result = await analyzerAt('2026-10-22T12:00:00.000Z').analyze({
      data: pdfWithText(fullBill),
      contentType: 'application/pdf',
    })

    expect(result.status).toBe('completed')
    expect(result.document.status).toBe('analyzed')
    expect(result.document.kind).toBe('unknown')
    // Emissão tem prioridade sobre Competência; ambas são observações, não validade.
    expect(result.document.issuedAt).toBe('2026-09-30')
    expect(result.document.issuedRaw).toBe('Data de emissão: 30/09/2026')
    expect(result.address.status).toBe('extracted')
    expect(result.address.value).toMatchObject({
      logradouro: 'RUA DAS FLORES',
      numero: '123',
      complemento: 'APTO 45',
      bairro: 'CENTRO',
      cidade: 'SAO PAULO',
      uf: 'SP',
      cep: '01001000',
    })
    expect(result.holder.status).toBe('extracted')
    expect(result.holder.value).toEqual({ name: 'Maria da Silva', raw: 'Titular: Maria da Silva' })
    expect(result.errorCodes).toEqual([])
    expect(result.analyzedAt).toBe('2026-10-22T12:00:00.000Z')
  })

  it('extrai texto de PDF com stream comprimido', async () => {
    const result = await analyzerAt('2026-10-22T12:00:00.000Z').analyze({
      data: pdfWithText(fullBill, { compress: true }),
      contentType: 'application/pdf',
    })
    expect(result.status).toBe('completed')
    expect(result.address.value?.cep).toBe('01001000')
  })

  it('não persiste CPF/CNPJ no resultado', async () => {
    const result = await analyzerAt('2026-10-22T12:00:00.000Z').analyze({
      data: pdfWithText(fullBill),
      contentType: 'application/pdf',
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('52998224725')
    expect(serialized).not.toContain('529.982.247-25')
    expect(serialized).not.toContain('11222333000181')
    expect(serialized).not.toContain('11.222.333/0001-81')
  })

  it('não transforma nome de estado em UF de duas letras', async () => {
    const result = await analyzerAt('2026-10-22T12:00:00.000Z').analyze({
      data: pdfWithText([
        'CONTA DE ENERGIA',
        'Endereço: Rua das Flores, 123',
        'Cidade: São Paulo',
        'Estado: São Paulo',
        'CEP: 01001-000',
      ]),
      contentType: 'application/pdf',
    })
    expect(result.address.status).toBe('extracted')
    expect(result.address.value?.uf).toBeNull()
  })

  it('não infere CEP sem rótulo', async () => {
    const result = await analyzerAt('2026-10-22T12:00:00.000Z').analyze({
      data: pdfWithText([
        'CONTA DE ENERGIA',
        'Distribuidora CEMIG - CEP 30110-000',
        'Endereço: Rua das Flores, 123',
        'Bairro: Centro',
        'Cidade: São Paulo',
        'UF: SP',
      ]),
      contentType: 'application/pdf',
    })
    expect(result.address.status).toBe('extracted')
    expect(result.address.value?.cep).toBeNull()
  })

  it('não extrai endereço quando o rótulo é ambíguo', async () => {
    const result = await analyzerAt('2026-10-22T12:00:00.000Z').analyze({
      data: pdfWithText([
        'CONTA DE ENERGIA',
        'Endereço: Rua da Distribuidora, 1',
        'Endereço: Rua das Flores, 123',
        'Titular: Maria da Silva',
      ]),
      contentType: 'application/pdf',
    })
    expect(result.address.status).toBe('not_extracted')
    expect(result.address.value).toBeNull()
  })

  it('marca address = not_extracted quando o documento não traz endereço', async () => {
    const result = await analyzerAt('2026-10-22T12:00:00.000Z').analyze({
      data: pdfWithText(['CONTA DE ENERGIA', 'Titular: Maria da Silva']),
      contentType: 'application/pdf',
    })
    expect(result.status).toBe('completed')
    expect(result.address.status).toBe('not_extracted')
    expect(result.address.value).toBeNull()
    expect(result.holder.status).toBe('extracted')
  })

  it('marca holder = not_extracted quando o documento não traz titular', async () => {
    const result = await analyzerAt('2026-10-22T12:00:00.000Z').analyze({
      data: pdfWithText(['CONTA DE AGUA', 'Endereço: Rua das Flores, 123', 'CEP: 01001-000']),
      contentType: 'application/pdf',
    })
    expect(result.status).toBe('completed')
    expect(result.holder.status).toBe('not_extracted')
    expect(result.holder.value).toBeNull()
    expect(result.address.status).toBe('extracted')
  })

  it('não inventa competência quando a data é inválida', async () => {
    const result = await analyzerAt('2026-10-22T12:00:00.000Z').analyze({
      data: pdfWithText([
        'CONTA DE ENERGIA',
        'Competência: 31/02/2026',
        'Endereço: Rua das Flores, 123',
        'CEP: 01001-000',
      ]),
      contentType: 'application/pdf',
    })
    expect(result.status).toBe('completed')
    expect(result.document.issuedAt).toBeNull()
    expect(result.document.issuedRaw).toContain('31/02/2026')
  })

  it('documento inválido vira inconclusive/invalid e não produz address = differs', async () => {
    const result = await analyzerAt('2026-10-22T12:00:00.000Z').analyze({
      data: Buffer.from('%PDF-1.4\nnot a real pdf\n'),
      contentType: 'application/pdf',
    })
    expect(result.status).toBe('inconclusive')
    expect(result.document.status).toBe('invalid')
    expect(result.address.status).toBe('unknown')
    expect(result.holder.status).toBe('unknown')
  })

  it('PDF sem camada textual vira inconclusive', async () => {
    const result = await analyzerAt('2026-10-22T12:00:00.000Z').analyze({
      data: pdfWithText([], { withContent: false }),
      contentType: 'application/pdf',
    })
    expect(result.status).toBe('inconclusive')
    expect(result.document.status).toBe('inconclusive')
    expect(result.errorCodes).toContain('NO_TEXT_LAYER')
  })

  it('imagem vira unsupported (OCR fora do MVP), sem provider externo', async () => {
    const result = await analyzerAt('2026-10-22T12:00:00.000Z').analyze({
      data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      contentType: 'image/jpeg',
    })
    expect(result.status).toBe('unsupported')
    expect(result.document.status).toBe('unsupported')
    expect(result.address.status).toBe('unknown')
    expect(result.errorCodes).toContain('OCR_NOT_IMPLEMENTED')
  })
})
