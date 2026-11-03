import {
  normalizeText,
  redactFiscalReference,
  type DocumentAnalysisDimension,
  type DocumentAnalysisFieldSource,
  type DocumentAnalysisFieldSources,
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
import { fieldsFromPdfText, type PdfFields } from './fields.js'
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
 * Fonte de um campo. `marker_table` indica candidato extraído das tabelas
 * estruturadas do Marker.
 */
type FieldSource = DocumentAnalysisFieldSource

interface SourcedAddress {
  readonly source: FieldSource
  readonly value: ExtractedAddress
}

interface SourcedHolder {
  readonly source: FieldSource
  readonly value: ExtractedHolder
}

interface ResolvedField<T> {
  readonly value: T | null
  readonly source: FieldSource | null
  readonly conflict: boolean
}

const ADDRESS_COMPARE_FIELDS = [
  'logradouro',
  'numero',
  'complemento',
  'bairro',
  'cidade',
  'uf',
  'cep',
] as const

/** Dois valores só divergem quando ambos existem e são diferentes. */
const valuesAgree = (a: string | null, b: string | null): boolean =>
  a === null || b === null || normalizeText(a) === normalizeText(b)

/** CEP compara apenas dígitos: `01001-000` e `01001000` são o mesmo CEP. */
const cepDigits = (value: string | null): string | null => {
  const digits = value?.replace(/\D+/g, '') ?? ''
  return digits.length > 0 ? digits : null
}

const addressesAgree = (a: ExtractedAddress, b: ExtractedAddress): boolean =>
  ADDRESS_COMPARE_FIELDS.every((field) =>
    field === 'cep' ? valuesAgree(cepDigits(a.cep), cepDigits(b.cep)) : valuesAgree(a[field], b[field]),
  )

const addressCompleteness = (value: ExtractedAddress): number =>
  ADDRESS_COMPARE_FIELDS.filter((field) => value[field] !== null).length

/**
 * Resolve o endereço entre fontes (texto local, texto do Marker, tabelas).
 *
 * - Só uma fonte → usa.
 * - Fontes compatíveis (campos presentes concordam) → usa a mais completa,
 *   preservando o `raw` da fonte escolhida.
 * - Fontes divergentes → `null` (ambiguidade); nenhuma é escolhida
 *   arbitrariamente.
 */
const resolveAddress = (candidates: readonly SourcedAddress[]): ResolvedField<ExtractedAddress> => {
  const first = candidates[0]
  if (first === undefined) return { value: null, source: null, conflict: false }
  const diverges = candidates.some((candidate, index) =>
    candidates.slice(index + 1).some((other) => !addressesAgree(candidate.value, other.value)),
  )
  if (diverges) {
    return { value: null, source: null, conflict: true }
  }
  let best = first
  for (const candidate of candidates.slice(1)) {
    if (addressCompleteness(candidate.value) > addressCompleteness(best.value)) best = candidate
  }
  return { value: best.value, source: best.source, conflict: false }
}

/** Mesma regra do endereço: nomes divergentes entre fontes → ambiguidade. */
const resolveHolder = (candidates: readonly SourcedHolder[]): ResolvedField<ExtractedHolder> => {
  const first = candidates[0]
  if (first === undefined) return { value: null, source: null, conflict: false }
  const nameOf = (holder: ExtractedHolder): string | null =>
    holder.name === null ? null : normalizeText(holder.name)
  if (candidates.some((candidate) => !valuesAgree(nameOf(first.value), nameOf(candidate.value)))) {
    return { value: null, source: null, conflict: true }
  }
  let best = first
  for (const candidate of candidates.slice(1)) {
    if (best.value.name === null && candidate.value.name !== null) best = candidate
  }
  return { value: best.value, source: best.source, conflict: false }
}

interface MergedFields {
  readonly address: ExtractedAddress | null
  readonly holder: ExtractedHolder | null
  readonly addressSource: FieldSource | null
  readonly holderSource: FieldSource | null
  readonly limitations: readonly string[]
  readonly conflicts: readonly ('address' | 'holder')[]
}

/**
 * Combina as fontes de campo disponíveis (texto local, texto do Marker e
 * tabelas do Marker) com comparação explícita. Campos já extraídos do texto
 * não são substituídos por outro valor sem verificação; divergência entre
 * fontes vira ausência + limitação observável.
 */
const mergeFieldCandidates = (
  textFields: readonly { readonly source: 'local' | 'marker'; readonly fields: PdfFields | null }[],
  tables: readonly TableCandidate[],
): MergedFields => {
  const addressCandidates: SourcedAddress[] = []
  const holderCandidates: SourcedHolder[] = []

  for (const { source, fields } of textFields) {
    if (fields === null) continue
    if (fields.address !== null) addressCandidates.push({ source, value: fields.address })
    if (fields.holder !== null) holderCandidates.push({ source, value: fields.holder })
  }

  if (tables.length > 0) {
    const tableAddress = addressFromTableCandidates(tables)
    if (tableAddress !== null) addressCandidates.push({ source: 'marker_table', value: tableAddress })
    const tableHolder = holderFromTableCandidates(tables)
    if (tableHolder !== null) holderCandidates.push({ source: 'marker_table', value: tableHolder })
  }

  const address = resolveAddress(addressCandidates)
  const holder = resolveHolder(holderCandidates)
  const limitations: string[] = []
  const conflicts: ('address' | 'holder')[] = []
  if (address.conflict) {
    limitations.push('FIELD_CONFLICT_ADDRESS')
    conflicts.push('address')
  }
  if (holder.conflict) {
    limitations.push('FIELD_CONFLICT_HOLDER')
    conflicts.push('holder')
  }

  return {
    address: address.value,
    holder: holder.value,
    addressSource: address.source,
    holderSource: holder.source,
    limitations,
    conflicts,
  }
}

/**
 * Origem por campo só é registrada quando difere da fonte do texto-base
 * (`provenance.provider`). Sem mistura, o resultado permanece idêntico ao
 * contrato anterior.
 */
const fieldSourcesOf = (
  merged: MergedFields,
  provider: 'local' | 'marker',
): DocumentAnalysisFieldSources | undefined => {
  const address =
    merged.addressSource !== null && merged.addressSource !== provider ? merged.addressSource : null
  const holder = merged.holderSource !== null && merged.holderSource !== provider ? merged.holderSource : null
  if (address === null && holder === null) return undefined
  return {
    ...(address === null ? {} : { address }),
    ...(holder === null ? {} : { holder }),
  }
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
    const localTextNonEmpty = normalizedLocal.length >= MIN_TEXT_CHARS

    emitDebug(trace, {
      code: 'pdf.text',
      level: localText === null ? 'warning' : localTextNonEmpty ? 'success' : 'warning',
      message:
        localText === null
          ? 'Não foi possível extrair a camada textual do PDF.'
          : localTextNonEmpty
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

    // 3) Decidir fonte de texto e quando acionar o Marker.
    //
    // Política de fallback explícita:
    //   a) Camada local entrega titular E endereço → usar unpdf, sem Marker.
    //   b) Camada local utilizável mas incompleta + Marker disponível → chamar
    //      o Marker para complementar. O texto local continua sendo o
    //      texto-base e nenhum campo local é substituído sem comparação.
    //   c) Camada local inutilizável (vazia/curta) + Marker → usar o texto do
    //      Marker como base.
    //   d) Marker falha ou não está configurado → fallback para a camada local
    //      com limitação observável.
    const localUsable = normalizedLocal.length >= MIN_TEXT_CHARS && normalizedLocal.length <= MAX_TEXT_CHARS
    const localOversized = normalizedLocal.length > MAX_TEXT_CHARS
    const localFields = localUsable ? fieldsFromPdfText(normalizedLocal) : null
    // Tamanho de texto, sozinho, não é evidência de conteúdo: um PDF com apenas
    // `CONTA DE ENERGIA` passa do mínimo e não tem titular nem endereço. O
    // Marker só é dispensado quando a camada local fornece os dois campos que o
    // analyzer precisa extrair.
    const localEnough = localFields !== null && localFields.address !== null && localFields.holder !== null
    const markerConfigured = marker !== null && marker !== undefined

    let provenance: DocumentAnalysisProvenance | undefined
    let markerResult: MarkerParseResult | null = null
    let markerFailureKind: string | null = null

    if (localEnough || localOversized) {
      // Documento acima do limite não é enviado ao Marker: o custo do OCR não
      // se justifica, o resultado terminal continua `TEXT_TOO_LONG`.
      emitDebug(trace, {
        code: 'text.local',
        level: localEnough ? 'success' : 'warning',
        message: localEnough
          ? 'Camada textual local fornece titular e endereço; Marker não necessário.'
          : 'Camada textual local excede o limite; Marker não consultado.',
        details: { chars: normalizedLocal.length },
      })
    } else if (markerConfigured) {
      // Chamar Marker para OCR/layout e/ou tabelas.
      try {
        // O PDF.js pode destacar (detach) o ArrayBuffer durante o parse do
        // unpdf; usamos a cópia independente (`dataCopy`) para o OCR do Marker.
        markerResult = await marker.parse(
          { data: dataCopy, filename: 'document.pdf', documentId: 'analysis' },
          trace,
        )
        emitDebug(trace, {
          code: 'text.marker',
          level: 'success',
          message: localUsable
            ? 'Marker consultado para complementar campos ausentes da camada local.'
            : 'Usando texto extraído pelo Marker (OCR/layout).',
          details: { chars: markerResult.text.length, pages: markerResult.pages },
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
        emitDebug(trace, {
          code: 'text.fallback',
          level: 'warning',
          message: 'Fallback para a camada textual local após falha do Marker.',
          details: { chars: normalizedLocal.length },
        })
      }
    } else {
      // Camada insuficiente e Marker não configurado: usar texto local com
      // limitação (não há OCR disponível). Sem Document Intelligence não há
      // proveniência a registrar (comportamento do contrato v3).
      emitDebug(trace, {
        code: 'text.fallback',
        level: 'warning',
        message: 'Camada textual insuficiente e Document Intelligence não configurado.',
        details: { chars: normalizedLocal.length, minChars: MIN_TEXT_CHARS },
      })
    }

    const markerText = markerResult?.text.trim() ?? ''
    const markerTextUsable = markerText.length >= MIN_TEXT_CHARS && markerText.length <= MAX_TEXT_CHARS
    // Texto-base: a camada local utilizável continua sendo a base (o Marker só
    // complementa); o texto do Marker só vira base quando a camada local não
    // serve.
    const provider: 'local' | 'marker' = !localUsable && markerTextUsable ? 'marker' : 'local'
    const bestText = provider === 'marker' ? markerText : normalizedLocal

    if (provider === 'marker' && markerResult !== null) {
      provenance = buildProvenance('marker', {
        markerVersion: markerResult.markerVersion,
        pages: markerResult.pages,
        processingTimeMs: markerResult.processingTimeMs,
      })
    } else if (markerConfigured) {
      // Proveniência só é registrada quando o Document Intelligence está
      // configurado; sem ele o resultado permanece idêntico ao contrato v3.
      provenance = buildProvenance('local', markerFailureKind === null ? {} : { fallback: true })
    } else {
      provenance = undefined
    }

    // Códigos extras para manter a limitação observável sem perder o código
    // principal anterior (`NO_TEXT_LAYER`/`PDF_TEXT_EXTRACTION_FAILED`).
    const markerExtraCodes: string[] = []
    if (markerFailureKind !== null) {
      markerExtraCodes.push(`MARKER_${markerFailureKind.toUpperCase()}`)
    } else if (markerResult !== null && !markerTextUsable) {
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

    // 4) Combinar as fontes de campo disponíveis (texto local, texto do Marker
    // e tabelas do Marker) antes de decidir o status. A comparação é explícita:
    // valores equivalentes são mantidos, divergentes não são escolhidos.
    const markerFields = markerTextUsable ? fieldsFromPdfText(markerText) : null
    const textFields: { readonly source: 'local' | 'marker'; readonly fields: PdfFields | null }[] = []
    if (localFields !== null) textFields.push({ source: 'local', fields: localFields })
    if (markerFields !== null) textFields.push({ source: 'marker', fields: markerFields })
    const tableCandidates = markerResult === null ? [] : extractTableCandidates(markerResult.tables)
    const merged = mergeFieldCandidates(textFields, tableCandidates)

    const baseFields = provider === 'marker' ? markerFields : localFields
    const limitations = [...(baseFields?.limitations ?? []), ...merged.limitations]
    // Uma falha do Marker permanece observável mesmo quando a análise conclui
    // com a camada local.
    limitations.push(...markerExtraCodes)

    // Sem texto utilizável e sem campos de tabela, não há evidência a extrair.
    // Um conflito entre fontes também é evidência: nesse caso o resultado
    // continua `completed` com a limitação `FIELD_CONFLICT_*`.
    const hasMergedField = merged.address !== null || merged.holder !== null
    if (bestText.length < MIN_TEXT_CHARS && !hasMergedField && merged.conflicts.length === 0) {
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

    // Origem por campo só aparece quando difere do texto-base; sem mistura o
    // resultado permanece idêntico ao contrato anterior.
    const fieldSources = fieldSourcesOf(merged, provider)
    const finalProvenance: DocumentAnalysisProvenance | undefined =
      fieldSources === undefined
        ? provenance
        : { ...(provenance ?? buildProvenance(provider)), fields: fieldSources }

    const address: DocumentAnalysisDimension<ExtractedAddress> =
      merged.address === null
        ? { status: 'not_extracted', value: null, raw: null }
        : { status: 'extracted', value: merged.address, raw: merged.address.raw }
    const holder: DocumentAnalysisDimension<ExtractedHolder> =
      merged.holder === null
        ? { status: 'not_extracted', value: null, raw: null }
        : { status: 'extracted', value: merged.holder, raw: merged.holder.raw }

    emitDebug(trace, {
      code: 'fields.merge',
      level: merged.conflicts.length > 0 ? 'warning' : 'info',
      message:
        merged.conflicts.length > 0
          ? `Fontes de campo divergentes: ${merged.conflicts.join(', ')}.`
          : 'Fontes de campo combinadas sem divergência.',
      details: {
        provider,
        addressSource: merged.addressSource,
        holderSource: merged.holderSource,
        conflicts: merged.conflicts,
        tables: tableCandidates.length,
        limitations: merged.limitations,
      },
    })
    if (merged.conflicts.length > 0) {
      emitDebug(trace, {
        code: 'fields.conflict',
        level: 'warning',
        message: 'Campos divergentes entre texto e tabela foram mantidos como ausentes.',
        details: { fields: merged.conflicts, limitations: merged.limitations },
      })
    }

    emitDebug(trace, {
      code: 'document.fields',
      level: address.status === 'extracted' || holder.status === 'extracted' ? 'success' : 'info',
      message: `Campos extraídos (endereço: ${address.status}; titular: ${holder.status}; fonte: ${provider}).`,
      details: {
        kind: baseFields?.kind ?? 'unknown',
        issuedAt: baseFields?.issuedAt ?? null,
        issuedRaw: baseFields?.issuedRaw ?? null,
        address: address.value,
        holder: holder.value,
        limitations,
        provenance: finalProvenance,
      },
    })

    const result = withFiscalReference(
      {
        ...baseResult(now),
        status: 'completed',
        document: {
          status: 'analyzed',
          kind: baseFields?.kind ?? 'unknown',
          issuedAt: baseFields?.issuedAt ?? null,
          issuedRaw: baseFields?.issuedRaw ?? null,
        },
        address,
        holder,
        limitations,
        errorCodes: [],
        provenance: finalProvenance,
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
