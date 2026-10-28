import { deflateSync } from 'node:zlib'

/**
 * Gerador de PDF mínimo e válido para testes do analyzer (xref incluído). Não é
 * um parser nem uma fixture NF3e: existe para exercitar o contrato com um PDF
 * que o PDF.js aceita, inclusive camada textual e stream comprimido.
 *
 * O texto é desenhado a partir de `72 720` na largura de `612`; linhas longas
 * podem ser truncadas pelo PDF.js ao ultrapassar a página — use `fontSize`
 * menor quando a linha precisar caber inteira (ex.: uma URL de consulta).
 */
const escapePdf = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

export interface PdfFixtureOptions {
  readonly compress?: boolean
  readonly withContent?: boolean
  readonly fontSize?: number
  /** QR module matrix, rendered as PDF rectangles instead of an image. */
  readonly vectorQr?: readonly string[]
}

export const pdfWithText = (lines: readonly string[], options: PdfFixtureOptions = {}): Buffer => {
  const fontSize = options.fontSize ?? 12
  const text = `BT\n/F1 ${fontSize} Tf\n72 720 Td\n${lines
    .map((line) => `(${escapePdf(line)}) Tj\n0 -20 Td\n`)
    .join('')}ET`
  const vectorQr = options.vectorQr ?? []
  const moduleSize = 6
  const qrX = 300
  const qrY = 100
  const qr = vectorQr
    .flatMap((row, rowIndex) =>
      [...row].flatMap((value, columnIndex) =>
        value === '1'
          ? `${qrX + columnIndex * moduleSize} ${qrY + (vectorQr.length - rowIndex - 1) * moduleSize} ${moduleSize} ${moduleSize} re\n`
          : [],
      ),
    )
    .join('')
  const content = `${text}\n${qr.length > 0 ? `${qr}f` : ''}`
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
