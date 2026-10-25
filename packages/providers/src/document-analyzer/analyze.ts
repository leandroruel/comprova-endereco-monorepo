import {
  redactFiscalReference,
  type DocumentAnalysisDimension,
  type DocumentAnalysisResult,
  type ExtractedAddress,
  type ExtractedHolder,
  type FiscalReference,
} from '@comprova/core'
import { extractText, getDocumentProxy } from 'unpdf'
import { extractFiscalReferenceFromArtifact, extractFiscalReferenceFromPdf } from '../fiscal/reference.js'
import { fieldsFromPdfText } from './fields.js'
import { baseResult, inconclusiveResult, invalidResult, unsupportedResult } from './results.js'
import type { DocumentAnalyzerInput } from './types.js'

/**
 * Limites de orquestração, não de parsing. O PDF.js faz a leitura; o Comprova
 * apenas impede que um artefato grande demais consuma o worker sem limite.
 */
const MAX_PAGES = 50
const MAX_TEXT_CHARS = 1_000_000
const MIN_TEXT_CHARS = 8
const MAX_IMAGE_PIXELS = 16_000_000

const withFiscalReference = (
  result: DocumentAnalysisResult,
  reference: FiscalReference,
): DocumentAnalysisResult => ({
  ...result,
  // A URL do QR nunca é persistida. O fingerprint/documentId continuam.
  fiscalReference: redactFiscalReference(reference),
})

const analyzePdf = async (data: Uint8Array, now: Date): Promise<DocumentAnalysisResult> => {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    // O PDF.js recusa `Buffer` explicitamente, mesmo sendo um `Uint8Array`.
    // A view abaixo mantém os mesmos bytes sem copiar o artefato.
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    // `unpdf` empacota o PDF.js para Node/serverless e cuida de streams, fontes,
    // compressão e camada textual. Não mantemos parser próprio no Comprova.
    pdf = await getDocumentProxy(bytes, { verbosity: 0, maxImageSize: MAX_IMAGE_PIXELS })
  } catch (error) {
    if ((error as { name?: unknown }).name === 'PasswordException') {
      return unsupportedResult(now, 'PDF_ENCRYPTED')
    }
    return invalidResult(now, 'PDF_INVALID')
  }

  try {
    // A referência fiscal é extraída independentemente do texto: um PDF
    // escaneado pode não ter camada textual e ainda conter um QR raster.
    const fiscalReference = await extractFiscalReferenceFromPdf(pdf, {
      maxPdfPages: MAX_PAGES,
      maxImagePixels: MAX_IMAGE_PIXELS,
    })

    if (pdf.numPages > MAX_PAGES) {
      return withFiscalReference(inconclusiveResult(now, 'TOO_MANY_PAGES'), fiscalReference)
    }

    let text: string
    try {
      const extracted = await extractText(pdf, { mergePages: true })
      text = extracted.text
    } catch {
      return withFiscalReference(inconclusiveResult(now, 'PDF_TEXT_EXTRACTION_FAILED'), fiscalReference)
    }

    const normalized = text.trim()
    if (normalized.length < MIN_TEXT_CHARS) {
      return withFiscalReference(inconclusiveResult(now, 'NO_TEXT_LAYER'), fiscalReference)
    }
    if (normalized.length > MAX_TEXT_CHARS) {
      return withFiscalReference(inconclusiveResult(now, 'TEXT_TOO_LONG'), fiscalReference)
    }

    const fields = fieldsFromPdfText(normalized)
    const address: DocumentAnalysisDimension<ExtractedAddress> =
      fields.address === null
        ? { status: 'not_extracted', value: null, raw: null }
        : { status: 'extracted', value: fields.address, raw: fields.address.raw }
    const holder: DocumentAnalysisDimension<ExtractedHolder> =
      fields.holder === null
        ? { status: 'not_extracted', value: null, raw: null }
        : { status: 'extracted', value: fields.holder, raw: fields.holder.raw }

    return withFiscalReference(
      {
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
      },
      fiscalReference,
    )
  } finally {
    // `getDocumentProxy` devolve um documento com lifecycle do chamador.
    await pdf.loadingTask.destroy().catch(() => undefined)
  }
}

export const analyzeDocument = async (
  input: DocumentAnalyzerInput,
  now: Date,
): Promise<DocumentAnalysisResult> => {
  if (input.contentType === 'application/pdf') return analyzePdf(input.data, now)

  const fiscalReference = await extractFiscalReferenceFromArtifact({
    data: input.data,
    contentType: input.contentType,
  })

  if (input.contentType === 'image/jpeg' || input.contentType === 'image/png') {
    // OCR/VLM são implementações futuras do mesmo protocolo; nenhum PII sai
    // do processo nesta etapa. O QR, porém, já é extraído localmente.
    return withFiscalReference(unsupportedResult(now, 'OCR_NOT_IMPLEMENTED'), fiscalReference)
  }
  return withFiscalReference(unsupportedResult(now, 'UNSUPPORTED_CONTENT_TYPE'), fiscalReference)
}
