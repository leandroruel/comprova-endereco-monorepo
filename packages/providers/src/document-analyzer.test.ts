import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { makeDocumentAnalyzer } from './document-analyzer/index.js'

const escapePdf = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

const pdfWithText = (lines: readonly string[]): Buffer => {
  const content = `BT\n/F1 12 Tf\n72 720 Td\n${lines
    .map((line) => `(${escapePdf(line)}) Tj\n0 -20 Td\n`)
    .join('')}ET`
  return Buffer.from(
    `%PDF-1.4\n` +
      `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
      `2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n` +
      `3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n` +
      `4 0 obj << /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n` +
      `trailer << /Root 1 0 R >>\n%%EOF\n`,
    'latin1',
  )
}

const pdfWithCompressedText = (lines: readonly string[]): Buffer => {
  const content = `BT\n/F1 12 Tf\n72 720 Td\n${lines
    .map((line) => `(${escapePdf(line)}) Tj\n0 -20 Td\n`)
    .join('')}ET`
  const compressed = deflateSync(Buffer.from(content, 'latin1'))
  const header = Buffer.from(
    `%PDF-1.4\n` +
      `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
      `2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n` +
      `3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n` +
      `4 0 obj << /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`,
    'latin1',
  )
  const footer = Buffer.from(`\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1')
  return Buffer.concat([header, compressed, footer])
}

const analyzerAt = (iso: string) => makeDocumentAnalyzer({ now: () => new Date(iso) })

const fullBill = [
  'CONTA DE ENERGIA',
  'Titular: Maria da Silva',
  'CPF: 529.982.247-25',
  'Endereço: Rua das Flores, 123, Apto 45',
  'Bairro: Centro',
  'Cidade: São Paulo',
  'UF: SP',
  'CEP: 01001-000',
  'Vencimento: 10/11/2026',
]

describe('makeDocumentAnalyzer (F1.2)', () => {
  it('extrai endereço e titular normalizados de PDF textual', async () => {
    const result = await analyzerAt('2026-10-22T12:00:00.000Z').analyze({
      data: pdfWithText(fullBill),
      contentType: 'application/pdf',
    })

    expect(result.status).toBe('completed')
    expect(result.document.status).toBe('analyzed')
    expect(result.document.kind).toBe('electricity_bill')
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
    expect(result.holder.value).toMatchObject({
      name: 'Maria da Silva',
      taxId: '52998224725',
      taxIdType: 'CPF',
    })
    expect(result.errorCodes).toEqual([])
    expect(result.analyzedAt).toBe('2026-10-22T12:00:00.000Z')
  })

  it('extrai texto de stream FlateDecode', async () => {
    const result = await analyzerAt('2026-10-22T12:00:00.000Z').analyze({
      data: pdfWithCompressedText(fullBill),
      contentType: 'application/pdf',
    })
    expect(result.status).toBe('completed')
    expect(result.address.status).toBe('extracted')
    expect(result.address.value?.cep).toBe('01001000')
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

  it('não usa o CEP do cabeçalho quando não há CEP rotulado', async () => {
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

  it('extrai CEP da linha de endereço quando não há CEP rotulado', async () => {
    const result = await analyzerAt('2026-10-22T12:00:00.000Z').analyze({
      data: pdfWithText(['CONTA DE ENERGIA', 'Endereço: Rua das Flores, 123 - CEP 01001-000']),
      contentType: 'application/pdf',
    })
    expect(result.address.status).toBe('extracted')
    expect(result.address.value?.cep).toBe('01001000')
  })

  it('não usa CNPJ da distribuidora como titular quando não há rótulo', async () => {
    const result = await analyzerAt('2026-10-22T12:00:00.000Z').analyze({
      data: pdfWithText([
        'CONTA DE ENERGIA',
        'Distribuidora CEMIG - CNPJ 11.222.333/0001-81',
        'Titular: Maria da Silva',
        'CPF: 529.982.247-25',
        'Endereço: Rua das Flores, 123',
        'CEP: 01001-000',
      ]),
      contentType: 'application/pdf',
    })
    expect(result.holder.status).toBe('extracted')
    expect(result.holder.value).toMatchObject({
      name: 'Maria da Silva',
      taxId: '52998224725',
      taxIdType: 'CPF',
    })
  })

  it('marca address = not_extracted quando o documento não traz endereço', async () => {
    const result = await analyzerAt('2026-10-22T12:00:00.000Z').analyze({
      data: pdfWithText(['CONTA DE ENERGIA', 'Titular: Maria da Silva', 'CPF: 529.982.247-25']),
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

  it('não transforma CPF inválido em titular diferente', async () => {
    const result = await analyzerAt('2026-10-22T12:00:00.000Z').analyze({
      data: pdfWithText(['Titular: Maria da Silva', 'CPF: 111.111.111-11', 'CEP: 01001-000']),
      contentType: 'application/pdf',
    })
    expect(result.holder.status).toBe('extracted')
    expect(result.holder.value?.name).toBe('Maria da Silva')
    expect(result.holder.value?.taxId).toBeNull()
    expect(result.limitations).toContain('TAX_ID_INVALID')
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
      data: Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n'),
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
