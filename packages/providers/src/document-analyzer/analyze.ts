import {
  redactFiscalReference,
  type DocumentAnalysisDimension,
  type DocumentAnalysisProvenance,
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
import {
  addressFromTableCandidates,
  extractTableCandidates,
  holderFromTableCandidates,
  type TableCandidate,
} from './structured.js'
import { baseResult, inconclusiveResult, invalidResult, unsupportedResult } from './results.js'
import type { DocumentAnalyzerInput } from './types.js'
import { MarkerAdapterError, type MarkerParseResult } from './marker.js'

/**
 * Limites de orquestração, não de parsing. O PDF.js faz a leitura; o Comprova
 * apenas impede que um artefato grande demais consuma o worker sem limite.
 */
const MAX_PAGES = FISCAL_REFERENCE_MAX_PDF_PAGES
const MAX_TEXT_CHARS = 1_000_000
const MIN_TEXT_CHARS = 8
const MAX_IMAGE_PIXELS = FISCAL_REFERENCE_MAX_IMAGE_PIXELS

/**
 * Interface mínima do adapter Marker necessária pelo analyzer. Desacopla
 * `analyze.ts` da implementação concreta em `marker.ts`.
 */
export interface MarkerAdapter {
  readonly parse: (
    input: {
      readonly data: Uint8Array
      readonly filename: string
      readonly documentId: string
      readonly signal?: AbortSignal | undefined
    },
    trace?: DebugTraceSink,
  ) => Promise<MarkerParseResult>
}

const withFiscalReference = (
  result: DocumentAnalysisResult,
  reference: FiscalReference,
): DocumentAnalysisResult => ({
  ...result,
  // A URL do QR nunca é persistida. O fingerprint/documentId continuam.
  fiscalReference: redactFiscalReference(reference),
})

/**
 * Anexa a proveniência (fonte do texto/fallback) a qualquer resultado —
 * inclusive inconclusivo — para que o caminho percorrido seja observável.
 */
const withProvenance = (
  result: DocumentAnalysisResult,
  provenance: DocumentAnalysisProvenance | undefined,
): DocumentAnalysisResult => (provenance === undefined ? result : { ...result, provenance })

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

/**
 * Constrói o objeto de proveniência para o resultado da análise.
 */
const buildProvenance = (
  provider: 'local' | 'marker',
  overrides?: {
    readonly markerVersion?: string
    readonly pages?: number
    readonly processingTimeMs?: number
    readonly fallback?: boolean
  },
): DocumentAnalysisProvenance => ({
  provider,
  ...(overrides?.markerVersion === undefined ? {} : { markerVersion: overrides.markerVersion }),
  ...(overrides?.pages === undefined ? {} : { pages: overrides.pages }),
  ...(overrides?.processingTimeMs === undefined ? {} : { processingTimeMs: overrides.processingTimeMs }),
  ...(overrides?.fallback === undefined ? {} : { fallback: overrides.fallback }),
})

/**
 * Completa campos ausentes (`not_extracted`) usando candidatos de tabela do
 * Marker, sem sobrescrever valores já extraídos do texto. Conflitos entre
 * texto e tabela são tratados como ambiguidade (campo fica nulo).
 */
const mergeTableCandidates = (
  fields: {
    readonly address: ExtractedAddress | null
    readonly holder: ExtractedHolder | null
  },
  tables: readonly TableCandidate[],
): {
  readonly address: ExtractedAddress | null
  readonly holder: ExtractedHolder | null
  readonly limitations: readonly string[]
} => {
  let address = fields.address
  let holder = fields.holder

  if (address === null) {
    const tableAddress = addressFromTableCandidates(tables)
    if (tableAddress !== null) {
      // Endereço veio apenas da tabela; registrar como evidência complementar.
      address = tableAddress
    }
  }

  if (holder === null) {
    const tableHolder = holderFromTableCandidates(tables)
    if (tableHolder !== null) {
      holder = tableHolder
    }
  }

  return { address, holder, limitations: [] }
}

const analyzePdf = async (
  data: Uint8Array,
  now: Date,
  trace?: DebugTraceSink,
  marker?: MarkerAdapter | null,
): Promise<DocumentAnalysisResult> => {
  // O PDF.js (via unpdf) pode destacar (detach) o ArrayBuffer do Uint8Array
  // durante o parse. Guardamos uma cópia independente logo no início para
  // poder reutilizar os bytes depois, por exemplo para o OCR do Marker.
  const dataCopy = Uint8Array.from(data)

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
    let localText: string | null = null
    try {
      const extracted = await extractText(pdf, { mergePages: true })
      localText = extracted.text
    } catch {
      localText = null
    }

    const normalizedLocal = localText?.trim() ?? ''
    const localTextSufficient = normalizedLocal.length >= MIN_TEXT_CHARS

    emitDebug(trace, {
      code: 'pdf.text',
      level: localText === null ? 'warning' : localTextSufficient ? 'success' : 'warning',
      message:
        localText === null
          ? 'Não foi possível extrair a camada textual do PDF.'
          : localTextSufficient
            ? `Camada textual extraída (${normalizedLocal.length} caracteres).`
            : 'O PDF não tem camada textual utilizável.',
      details: { chars: normalizedLocal.length, minChars: MIN_TEXT_CHARS },
    })

    // 2) Referência fiscal: camada textual + QR (caminho determinístico,
    // inalterado pelo Marker). O QR nunca é extraído pelo OCR do Marker.
    const textReference =
      normalizedLocal.length >= MIN_TEXT_CHARS && normalizedLocal.length <= MAX_TEXT_CHARS
        ? extractFiscalReferenceFromText(normalizedLocal)
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

    const textIsComplete = textFound !== null && textFound.documentId !== null && textFound.issuer !== null

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

    // 3) Decidir fonte de texto para extração de campos.
    //
    // Política de fallback explícita:
    //   a) Camada local suficiente → usar unpdf, não chama o Marker.
    //   b) Camada local insuficiente + Marker disponível → chamar Marker.
    //      Se Marker falhar, fallback para o texto local (mesmo insuficiente)
    //      com limitação registrada.
    //   c) Camada local insuficiente + Marker indisponível → usar texto local
    //      com limitação (sem OCR).
    let bestText: string
    let provenance: DocumentAnalysisProvenance | undefined
    let markerResult: MarkerParseResult | null = null
    let markerFailureKind: string | null = null

    if (localTextSufficient) {
      bestText = normalizedLocal
      // Proveniência só é registrada quando o Document Intelligence está
      // configurado; sem ele o resultado permanece idêntico ao contrato v3.
      provenance = marker !== null && marker !== undefined ? buildProvenance('local') : undefined
      emitDebug(trace, {
        code: 'text.local',
        level: 'info',
        message: 'Usando camada textual local (unpdf); Marker não necessário.',
        details: { chars: bestText.length },
      })
    } else if (marker !== null && marker !== undefined) {
      // Chamar Marker para OCR/layout.
      try {
        // O PDF.js pode destacar (detach) o ArrayBuffer durante o parse do
        // unpdf; usamos a cópia independente (`dataCopy`) para o OCR do Marker.
        markerResult = await marker.parse(
          { data: dataCopy, filename: 'document.pdf', documentId: 'analysis' },
          trace,
        )
        bestText = markerResult.text
        provenance = buildProvenance('marker', {
          markerVersion: markerResult.markerVersion,
          pages: markerResult.pages,
          processingTimeMs: markerResult.processingTimeMs,
        })
        emitDebug(trace, {
          code: 'text.marker',
          level: 'success',
          message: 'Usando texto extraído pelo Marker (OCR/layout).',
          details: { chars: bestText.length, pages: markerResult.pages },
        })
      } catch (error) {
        markerFailureKind = error instanceof MarkerAdapterError ? error.kind : 'unknown'
        if (error instanceof MarkerAdapterError) {
          emitDebug(trace, {
            code: 'marker.fallback',
            level: 'warning',
            message: `Marker indisponível (${error.kind}); fallback para a camada local.`,
            details: { kind: error.kind },
          })
        } else {
          emitDebug(trace, {
            code: 'marker.fallback',
            level: 'warning',
            message: 'Marker falhou inesperadamente; fallback para a camada local.',
            details: { reason: error instanceof Error ? error.message : String(error) },
          })
        }
        // Fallback explícito para o texto local, mesmo quando insuficiente.
        bestText = normalizedLocal
        provenance = buildProvenance('local', { fallback: true })
        emitDebug(trace, {
          code: 'text.fallback',
          level: 'warning',
          message: 'Fallback para a camada textual local após falha do Marker.',
          details: { chars: bestText.length },
        })
      }
    } else {
      // Camada insuficiente e Marker não configurado: usar texto local com
      // limitação (não há OCR disponível). Sem Document Intelligence não há
      // proveniência a registrar (comportamento do contrato v3).
      bestText = normalizedLocal
      provenance = undefined
      emitDebug(trace, {
        code: 'text.fallback',
        level: 'warning',
        message: 'Camada textual insuficiente e Document Intelligence não configurado.',
        details: { chars: bestText.length, minChars: MIN_TEXT_CHARS },
      })
    }

    // Códigos extras para manter a limitação observável sem perder o código
    // principal anterior (`NO_TEXT_LAYER`/`PDF_TEXT_EXTRACTION_FAILED`).
    const markerExtraCodes: string[] = []
    if (markerFailureKind !== null) {
      markerExtraCodes.push(`MARKER_${markerFailureKind.toUpperCase()}`)
    } else if (markerResult !== null) {
      markerExtraCodes.push('OCR_NO_USABLE_TEXT')
    }

    // 4) Se o texto local é nulo (não conseguiu extrair de jeito nenhum), o
    // documento não tem texto extraível nem OCR produziu resultado.
    if (localText === null && markerResult === null) {
      const base = inconclusiveResult(now, 'PDF_TEXT_EXTRACTION_FAILED')
      const result = withProvenance(
        withFiscalReference(
          {
            ...base,
            limitations: [...base.limitations, ...markerExtraCodes],
            errorCodes: [...base.errorCodes, ...markerExtraCodes],
          },
          fiscalReference,
        ),
        provenance,
      )
      emitAnalysisResult(trace, result)
      return result
    }

    // Se o melhor texto disponível ainda é insuficiente, não há campos para
    // extrair. Isso pode acontecer quando o fallback para o texto local
    // continua abaixo do mínimo.
    if (bestText.length < MIN_TEXT_CHARS) {
      const base = inconclusiveResult(now, 'NO_TEXT_LAYER')
      const result = withProvenance(
        withFiscalReference(
          {
            ...base,
            limitations: [...base.limitations, ...markerExtraCodes],
            errorCodes: [...base.errorCodes, ...markerExtraCodes],
          },
          fiscalReference,
        ),
        provenance,
      )
      emitAnalysisResult(trace, result)
      return result
    }

    if (bestText.length > MAX_TEXT_CHARS) {
      const result = withProvenance(
        withFiscalReference(inconclusiveResult(now, 'TEXT_TOO_LONG'), fiscalReference),
        provenance,
      )
      emitAnalysisResult(trace, result)
      return result
    }

    // 5) Extrair campos do texto escolhido.
    const fields = fieldsFromPdfText(bestText)
    let addressValue = fields.address
    let holderValue = fields.holder
    const limitations = [...fields.limitations]

    // 6) Se Marker foi usado e campos ainda estão ausentes, tentar extração
    // estruturada de tabelas (sem sobrescrever valores do texto).
    if (markerResult !== null) {
      const tableCandidates = extractTableCandidates(markerResult.tables)
      const merged = mergeTableCandidates({ address: addressValue, holder: holderValue }, tableCandidates)
      addressValue = merged.address
      holderValue = merged.holder
      if (merged.limitations.length > 0) limitations.push(...merged.limitations)
    }

    const address: DocumentAnalysisDimension<ExtractedAddress> =
      addressValue === null
        ? { status: 'not_extracted', value: null, raw: null }
        : { status: 'extracted', value: addressValue, raw: addressValue.raw }
    const holder: DocumentAnalysisDimension<ExtractedHolder> =
      holderValue === null
        ? { status: 'not_extracted', value: null, raw: null }
        : { status: 'extracted', value: holderValue, raw: holderValue.raw }

    emitDebug(trace, {
      code: 'document.fields',
      level: address.status === 'extracted' || holder.status === 'extracted' ? 'success' : 'info',
      message: `Campos extraídos (endereço: ${address.status}; titular: ${holder.status}; fonte: ${provenance?.provider ?? 'local'}).`,
      details: {
        kind: fields.kind,
        issuedAt: fields.issuedAt,
        issuedRaw: fields.issuedRaw,
        address: address.value,
        holder: holder.value,
        limitations,
        provenance,
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
        limitations,
        errorCodes: [],
        provenance,
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
  marker?: MarkerAdapter | null,
): Promise<DocumentAnalysisResult> => {
  if (input.contentType === 'application/pdf') return analyzePdf(input.data, now, trace, marker ?? null)

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

/**
 * Erro tipado do adapter Marker, reexportado para uso do caller.
 */
export { MarkerAdapterError }
