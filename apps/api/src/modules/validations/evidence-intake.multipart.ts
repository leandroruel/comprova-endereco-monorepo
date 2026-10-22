import type { FastifyRequest } from 'fastify'

/**
 * Folga para os headers/boundaries do multipart. O limite real do arquivo é
 * `EVIDENCE_MAX_BYTES`; o `Content-Length` é só um reject antecipado para não
 * começar a ler um payload claramente grande.
 */
export const EVIDENCE_MULTIPART_OVERHEAD_BYTES = 1_048_576

export type EvidenceMultipartFailure = 'missing_file' | 'too_many_parts' | 'malformed' | 'too_large'

export class EvidenceMultipartError extends Error {
  constructor(readonly reason: EvidenceMultipartFailure) {
    super(`evidence multipart rejected: ${reason}`)
  }
}

export interface UploadedEvidenceFile {
  readonly data: Buffer
  readonly filename: string
  readonly mimetype: string
}

const errorCodeOf = (error: unknown): string | null =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null

export const isMultipartError = (error: unknown): boolean => errorCodeOf(error)?.startsWith('FST_') === true

/**
 * Lê exatamente um arquivo do multipart. Campos de texto, múltiplos arquivos e
 * partes extras são rejeitados: o tenant nunca vem do body, e um payload
 * inesperado não deve ser interpretado pelo handler.
 *
 * `toBuffer` só materializa depois que o busboy aplicou `fileSize`; um arquivo
 * acima do limite falha antes de ser carregado inteiro. O limite é sempre
 * explícito (`maxBytes`), nunca o default do Fastify.
 */
export const readEvidenceFile = async (
  request: FastifyRequest,
  maxBytes: number,
): Promise<UploadedEvidenceFile> => {
  let fileName: string | undefined
  let mimeType: string | undefined
  let data: Buffer | undefined

  try {
    const parts = request.parts({
      limits: {
        fileSize: maxBytes,
        files: 1,
        fields: 0,
        parts: 1,
        fieldNameSize: 128,
        headerPairs: 32,
      },
    })

    for await (const part of parts) {
      if (part.type !== 'file') {
        throw new EvidenceMultipartError('malformed')
      }
      if (fileName !== undefined) {
        throw new EvidenceMultipartError('too_many_parts')
      }
      fileName = part.filename
      mimeType = part.mimetype
      data = await part.toBuffer()
    }
  } catch (error) {
    if (error instanceof EvidenceMultipartError) throw error
    const code = errorCodeOf(error)
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw new EvidenceMultipartError('too_large')
    if (code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT') {
      throw new EvidenceMultipartError('too_many_parts')
    }
    if (code === 'FST_FIELDS_LIMIT' || code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
      throw new EvidenceMultipartError('malformed')
    }
    // Qualquer outra falha do parser (corpo truncado, boundary inválido, etc.)
    // é um multipart malformado, não um erro interno. Não propagar a mensagem
    // do parser evita que detalhes do payload cheguem ao handler global.
    throw new EvidenceMultipartError('malformed')
  }

  if (fileName === undefined || mimeType === undefined || data === undefined) {
    throw new EvidenceMultipartError('missing_file')
  }

  return { data, filename: fileName, mimetype: mimeType }
}
