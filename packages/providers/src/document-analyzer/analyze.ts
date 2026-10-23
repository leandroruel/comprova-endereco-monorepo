import type {
  DocumentAnalysisDimension,
  DocumentAnalysisResult,
  ExtractedAddress,
  ExtractedHolder,
} from '@comprova/core'
import { extractPdfText } from '../pdf-text.js'
import { fieldsFromPdfText } from './fields.js'
import { baseResult, inconclusiveResult, invalidResult, unsupportedResult } from './results.js'
import type { DocumentAnalyzerInput } from './types.js'

const analyzePdf = (data: Uint8Array, now: Date): DocumentAnalysisResult => {
  const raw = Buffer.from(data).toString('latin1')
  const structurallyValid = raw.includes('%PDF-') && raw.includes('%%EOF')
  if (!structurallyValid) return invalidResult(now, 'PDF_INVALID')

  let text: string
  try {
    text = extractPdfText(data)
  } catch {
    return invalidResult(now, 'PDF_PARSE_FAILED')
  }
  if (text.trim().length < 8) return inconclusiveResult(now, 'NO_TEXT_LAYER')

  const fields = fieldsFromPdfText(text)
  const address: DocumentAnalysisDimension<ExtractedAddress> =
    fields.address === null
      ? { status: 'not_extracted', value: null, raw: null }
      : { status: 'extracted', value: fields.address, raw: fields.address.raw }
  const holder: DocumentAnalysisDimension<ExtractedHolder> =
    fields.holder === null
      ? { status: 'not_extracted', value: null, raw: null }
      : { status: 'extracted', value: fields.holder, raw: fields.holder.raw }

  return {
    ...baseResult(now),
    status: 'completed',
    document: {
      status: 'analyzed',
      kind: fields.kind,
      issuedAt: fields.issuedAt,
      issuedRaw: fields.issuedRaw,
    },
    address,
    holder,
    limitations: fields.limitations,
    errorCodes: [],
  }
}

export const analyzeDocument = (input: DocumentAnalyzerInput, now: Date): DocumentAnalysisResult => {
  if (input.contentType === 'application/pdf') return analyzePdf(input.data, now)
  if (input.contentType === 'image/jpeg' || input.contentType === 'image/png') {
    return unsupportedResult(now, 'OCR_NOT_IMPLEMENTED')
  }
  return unsupportedResult(now, 'UNSUPPORTED_CONTENT_TYPE')
}
