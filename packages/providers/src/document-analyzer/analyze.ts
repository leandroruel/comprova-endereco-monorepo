import {
  redactFiscalReference,
  type DocumentAnalysisDimension,
  type DocumentAnalysisResult,
  type ExtractedAddress,
  type ExtractedHolder,
  type FiscalReference,
} from '@comprova/core'
import { extractText, getDocumentProxy } from 'unpdf'
import { emitDebug, type DebugTraceSink } from '../debug-trace.js'
import {
  combineFiscalReferences,
  extractFiscalReferenceFromArtifact,
  extractFiscalReferenceFromPdf,
  extractFiscalReferenceFromText,
  FISCAL_REFERENCE_MAX_IMAGE_PIXELS,
  FISCAL_REFERENCE_MAX_PDF_PAGES,
  inconclusiveFiscalReference,
} from '../fiscal/reference.js'
import { fieldsFromPdfText } from './fields.js'
import { baseResult, inconclusiveResult, invalidResult, unsupportedResult } from './results.js'
import type { DocumentAnalyzerInput } from './types.js'

/**
 * Limites de orquestração, não de parsing. O PDF.js faz a leitura; o Comprova
 * apenas impede que um artefato grande demais consuma o worker sem limite.
 */
const MAX_PAGES = FISCAL_REFERENCE_MAX_PDF_PAGES
const MAX_TEXT_CHARS = 1_000_000
const MIN_TEXT_CHARS = 8
const MAX_IMAGE_PIXELS = FISCAL_REFERENCE_MAX_IMAGE_PIXELS

const withFiscalReference = (
  result: DocumentAnalysisResult,
  reference: FiscalReference,
): DocumentAnalysisResult => ({
  ...result,
  // A URL do QR nunca é persistida. O fingerprint/documentId continuam.
  fiscalReference: redactFiscalReference(reference),
})

const debugReferenceSummary = (reference: FiscalReference): Record<string, unknown> => ({
  status: reference.status,
  source: reference.source,
  issuer: reference.issuer,
  uf: reference.uf,
  url: reference.url,
  documentId: reference.documentId,
  method: reference.method,
  limitations: reference.limitations,
  errorCodes: reference.errorCodes,
})

const emitAnalysisResult = (trace: DebugTraceSink | undefined, result: DocumentAnalysisResult): void => {
  emitDebug(trace, {
    code: 'analysis.result',
    level: result.status === 'completed' ? 'success' : result.status === 'failed' ? 'error' : 'warning',
    message: `Análise do documento terminou com status ${result.status}.`,
    details: {
      status: result.status,
      document: result.document,
      limitations: result.limitations,
      errorCodes: result.errorCodes,
    },
  })
}

const analyzePdf = async (
  data: Uint8Array,
  now: Date,
  trace?: DebugTraceSink,
): Promise<DocumentAnalysisResult> => {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    // O PDF.js recusa `Buffer` explicitamente, mesmo sendo um `Uint8Array`.
    // A view abaixo mantém os mesmos bytes sem copiar o artefato.
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    // `unpdf` empacota o PDF.js para Node/serverless e cuida de streams, fontes,
    // compressão e camada textual. Não mantemos parser próprio no Comprova.
    pdf = await getDocumentProxy(bytes, { verbosity: 0, maxImageSize: MAX_IMAGE_PIXELS })
  } catch (error) {
    const encrypted = (error as { name?: unknown }).name === 'PasswordException'
    emitDebug(trace, {
      code: 'pdf.open',
      level: 'error',
      message: encrypted ? 'O PDF é criptografado.' : 'Não foi possível abrir o PDF.',
      details: { encrypted },
    })
    const result = encrypted ? unsupportedResult(now, 'PDF_ENCRYPTED') : invalidResult(now, 'PDF_INVALID')
    emitAnalysisResult(trace, result)
    return result
  }

  emitDebug(trace, {
    code: 'pdf.open',
    level: 'success',
    message: `PDF aberto (${pdf.numPages} página(s)).`,
    details: { pages: pdf.numPages },
  })

  try {
    // O limite de páginas é validado antes de qualquer decodificação de QR ou
    // extração de texto: o artefato não confiável não deve entrar no pipeline
    // de parsing apenas para ser descartado depois.
    if (pdf.numPages > MAX_PAGES) {
      emitDebug(trace, {
        code: 'pdf.pages.limit',
        level: 'warning',
        message: `O PDF tem ${pdf.numPages} páginas; o limite é ${MAX_PAGES}.`,
        details: { pages: pdf.numPages, maxPages: MAX_PAGES },
      })
      const result = withFiscalReference(
        inconclusiveResult(now, 'TOO_MANY_PAGES'),
        inconclusiveFiscalReference('PDF_TOO_MANY_PAGES'),
      )
      emitAnalysisResult(trace, result)
      return result
    }

    // 1) Camada textual: primeira tentativa determinística. O mesmo texto que
    // alimenta os campos do F1.2 é usado para reconhecer a URL de consulta ou
    // a chave de acesso — sem decodificar QR, renderizar página ou chamar VLM.
    let text: string | null = null
    try {
      const extracted = await extractText(pdf, { mergePages: true })
      text = extracted.text
    } catch {
      text = null
    }

    const normalized = text?.trim() ?? ''
    emitDebug(trace, {
      code: 'pdf.text',
      level: text === null ? 'warning' : normalized.length >= MIN_TEXT_CHARS ? 'success' : 'warning',
      message:
        text === null
          ? 'Não foi possível extrair a camada textual do PDF.'
          : normalized.length >= MIN_TEXT_CHARS
            ? `Camada textual extraída (${normalized.length} caracteres).`
            : 'O PDF não tem camada textual utilizável.',
      details: { chars: normalized.length, minChars: MIN_TEXT_CHARS },
    })

    const textReference =
      normalized.length >= MIN_TEXT_CHARS && normalized.length <= MAX_TEXT_CHARS
        ? extractFiscalReferenceFromText(normalized)
        : null
    const textFound = textReference?.status === 'found' ? textReference : null
    if (textReference !== null) {
      emitDebug(trace, {
        code: 'text.reference',
        level: textFound !== null ? 'success' : 'warning',
        message:
          textFound !== null
            ? 'Referência fiscal reconhecida na camada textual.'
            : 'Nenhuma referência fiscal completa na camada textual.',
        details: debugReferenceSummary(textReference),
      })
    }
    // A referência textual só dispensa o QR quando já é completa para a
    // consulta: documento identificado E autorizador reconhecido. Chave
    // isolada (`UNKNOWN_ISSUER`) ou URL sem chave ainda dependem do QR, que é
    // o artefato canônico do emitente e costuma trazer o autorizador.
    const textIsComplete = textFound !== null && textFound.documentId !== null && textFound.issuer !== null

    // 2) QR raster embutido: fallback determinístico já existente (F2.2b). Um
    // PDF escaneado pode não ter camada textual e ainda conter o QR como
    // imagem; e a referência textual incompleta não basta para a consulta.
    let fiscalReference: FiscalReference
    if (textIsComplete && textFound !== null) {
      fiscalReference = textFound
      emitDebug(trace, {
        code: 'fiscal.reference',
        level: 'success',
        message: 'Referência textual completa dispensa a leitura do QR.',
        details: debugReferenceSummary(fiscalReference),
      })
    } else {
      const qrReference = await extractFiscalReferenceFromPdf(pdf, {
        maxPdfPages: MAX_PAGES,
        maxImagePixels: MAX_IMAGE_PIXELS,
        onDebug: trace,
      })
      // Evidências compatíveis se completam (chave do texto + autorizador do
      // QR, por exemplo). Um QR só com autorizador não substitui a chave já
      // lida do texto, e duas chaves divergentes não são combinadas.
      // QR ilegível/ausente: a referência textual (ainda que incompleta) é
      // melhor evidência do que o resultado físico do QR.
      fiscalReference = textFound === null ? qrReference : combineFiscalReferences(textFound, qrReference)
      emitDebug(trace, {
        code: 'fiscal.reference',
        level: fiscalReference.status === 'found' ? 'success' : 'warning',
        message:
          textFound === null
            ? 'Referência fiscal definida pelo QR do documento.'
            : 'Referência textual e QR combinados.',
        details: debugReferenceSummary(fiscalReference),
      })
    }

    if (text === null) {
      const result = withFiscalReference(
        inconclusiveResult(now, 'PDF_TEXT_EXTRACTION_FAILED'),
        fiscalReference,
      )
      emitAnalysisResult(trace, result)
      return result
    }
    if (normalized.length < MIN_TEXT_CHARS) {
      const result = withFiscalReference(inconclusiveResult(now, 'NO_TEXT_LAYER'), fiscalReference)
      emitAnalysisResult(trace, result)
      return result
    }
    if (normalized.length > MAX_TEXT_CHARS) {
      const result = withFiscalReference(inconclusiveResult(now, 'TEXT_TOO_LONG'), fiscalReference)
      emitAnalysisResult(trace, result)
      return result
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

    emitDebug(trace, {
      code: 'document.fields',
      level: address.status === 'extracted' || holder.status === 'extracted' ? 'success' : 'info',
      message: `Campos extraídos do texto (endereço: ${address.status}; titular: ${holder.status}).`,
      details: {
        kind: fields.kind,
        issuedAt: fields.issuedAt,
        issuedRaw: fields.issuedRaw,
        address: address.value,
        holder: holder.value,
        limitations: fields.limitations,
      },
    })

    const result = withFiscalReference(
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
    emitAnalysisResult(trace, result)
    return result
  } finally {
    // `getDocumentProxy` devolve um documento com lifecycle do chamador.
    await pdf.loadingTask.destroy().catch(() => undefined)
  }
}

export const analyzeDocument = async (
  input: DocumentAnalyzerInput,
  now: Date,
  trace?: DebugTraceSink,
): Promise<DocumentAnalysisResult> => {
  if (input.contentType === 'application/pdf') return analyzePdf(input.data, now, trace)

  const fiscalReference = await extractFiscalReferenceFromArtifact({
    data: input.data,
    contentType: input.contentType,
    ...(trace === undefined ? {} : { onDebug: trace }),
  })

  if (input.contentType === 'image/jpeg' || input.contentType === 'image/png') {
    // OCR/VLM são implementações futuras do mesmo protocolo; nenhum PII sai
    // do processo nesta etapa. O QR, porém, já é extraído localmente.
    const result = withFiscalReference(unsupportedResult(now, 'OCR_NOT_IMPLEMENTED'), fiscalReference)
    emitAnalysisResult(trace, result)
    return result
  }
  const result = withFiscalReference(unsupportedResult(now, 'UNSUPPORTED_CONTENT_TYPE'), fiscalReference)
  emitAnalysisResult(trace, result)
  return result
}
