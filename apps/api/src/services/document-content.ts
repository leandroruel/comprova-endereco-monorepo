import { problems } from '@comprova/contracts'

/**
 * Validação de conteúdo de arquivos por magic bytes (F4.2).
 *
 * O tipo persistido é sempre o detectado no conteúdo, nunca o `Content-Type`
 * declarado pelo cliente. Formatos aceitos: PDF, JPEG e PNG. WebP fica de fora
 * porque o sniffer atual não consegue distingui-lo de forma confiável.
 */
export const DOCUMENT_CONTENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const

export type DocumentContentType = (typeof DOCUMENT_CONTENT_TYPES)[number]

const DOCUMENT_CONTENT_TYPE_SET: ReadonlySet<string> = new Set(DOCUMENT_CONTENT_TYPES)

const GENERIC_CONTENT_TYPES: ReadonlySet<string> = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
])

const startsWith = (data: Uint8Array, signature: readonly number[]): boolean =>
  data.byteLength >= signature.length && signature.every((byte, index) => data[index] === byte)

/** Normaliza `image/jpg` para `image/jpeg` e remove parâmetros. */
export const normalizeDocumentContentType = (value: string | undefined): string | null => {
  if (value === undefined) return null
  const [base] = value.split(';')
  const normalized = (base ?? '').trim().toLowerCase()
  if (normalized === 'image/jpg') return 'image/jpeg'
  return normalized
}

/** Detecta o tipo real pelo conteúdo. Não usa filename, extensão ou header. */
export const detectDocumentContentType = (data: Uint8Array): DocumentContentType | null => {
  if (startsWith(data, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf' // %PDF-
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg' // SOI + marker
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  return null
}

export type DocumentContentErrorCode = 'EMPTY' | 'TOO_LARGE' | 'UNSUPPORTED' | 'CONTENT_MISMATCH'

export class DocumentContentError extends Error {
  constructor(
    readonly code: DocumentContentErrorCode,
    readonly problem: ReturnType<typeof problems.unsupportedEvidenceType>,
  ) {
    super(code)
    this.name = 'DocumentContentError'
  }
}

const errorFor = (code: DocumentContentErrorCode): DocumentContentError => {
  switch (code) {
    case 'EMPTY':
      return new DocumentContentError(code, problems.evidenceEmpty())
    case 'TOO_LARGE':
      return new DocumentContentError(code, problems.evidenceTooLarge())
    case 'CONTENT_MISMATCH':
      return new DocumentContentError(code, problems.evidenceContentMismatch())
    case 'UNSUPPORTED':
      return new DocumentContentError(code, problems.unsupportedEvidenceType())
  }
}

/**
 * Valida tamanho, detecta o tipo real e exige compatibilidade com o
 * `Content-Type` declarado quando ele é específico. Retorna o tipo detectado.
 */
export const validateDocumentContent = (
  data: Uint8Array,
  declaredContentType: string | undefined,
  maxBytes: number,
): DocumentContentType => {
  if (data.byteLength === 0) throw errorFor('EMPTY')
  if (data.byteLength > maxBytes) throw errorFor('TOO_LARGE')

  const detected = detectDocumentContentType(data)
  if (detected === null) throw errorFor('UNSUPPORTED')

  const declared = normalizeDocumentContentType(declaredContentType)
  if (declared === null || GENERIC_CONTENT_TYPES.has(declared)) return detected
  if (!DOCUMENT_CONTENT_TYPE_SET.has(declared)) throw errorFor('UNSUPPORTED')
  if (declared !== detected) throw errorFor('CONTENT_MISMATCH')
  return detected
}
