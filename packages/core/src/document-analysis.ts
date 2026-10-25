/**
 * F1.2 — contrato da análise do documento do cliente.
 *
 * A análise é uma etapa INTERMEDIÁRIA entre o intake (F1.1) e a verificação
 * (F1.3/F2). Ela apenas extrai e normaliza campos do documento; **não** afirma
 * autenticidade, correspondência de endereço nem vínculo com o titular.
 *
 * Por isso a taxonomia é separada da taxonomia de verificação (ADR-0033):
 *
 *   document: analyzed | invalid | inconclusive | unsupported | unavailable
 *   address:  extracted | not_extracted | unknown
 *   holder:   extracted | not_extracted | unknown
 *
 * `matches`/`differs` e `authentic`/`not_found` pertencem ao verificador
 * (F1.3/F2) e nunca são produzidos aqui. O mapeamento futuro é:
 *
 *   extracted + comparação posterior -> matches | differs
 *   not_extracted                    -> not_extracted
 *   unknown/inconclusive/unavailable/unsupported -> unknown
 */

import type { FiscalReference } from './fiscal-reference.js'

export const DOCUMENT_ANALYSIS_CONTRACT_VERSION = '3'

/** Implementação MVP: texto de PDF + QR/referência fiscal, sem OCR. */
export const DOCUMENT_ANALYZER_ID = 'text_document'
export const DOCUMENT_ANALYZER_VERSION = '1.2.0'

export const DOCUMENT_ANALYSIS_STATUSES = [
  'pending',
  'analyzing',
  'completed',
  'inconclusive',
  'unsupported',
  'unavailable',
  'failed',
] as const

export type DocumentAnalysisStatus = (typeof DOCUMENT_ANALYSIS_STATUSES)[number]

/** Status persistido no resultado terminal (não inclui os estados de fila). */
export const DOCUMENT_ANALYSIS_TERMINAL_STATUSES = [
  'completed',
  'inconclusive',
  'unsupported',
  'unavailable',
  'failed',
] as const

export type DocumentAnalysisTerminalStatus = (typeof DOCUMENT_ANALYSIS_TERMINAL_STATUSES)[number]

export const DOCUMENT_ANALYSIS_DOCUMENT_STATUSES = [
  'analyzed',
  'invalid',
  'inconclusive',
  'unsupported',
  'unavailable',
] as const

export type DocumentAnalysisDocumentStatus = (typeof DOCUMENT_ANALYSIS_DOCUMENT_STATUSES)[number]

export const DOCUMENT_ANALYSIS_EXTRACTION_STATUSES = ['extracted', 'not_extracted', 'unknown'] as const

export type DocumentAnalysisExtractionStatus = (typeof DOCUMENT_ANALYSIS_EXTRACTION_STATUSES)[number]

export const DOCUMENT_ANALYSIS_KINDS = [
  'electricity_bill',
  'water_bill',
  'telecom_bill',
  'gas_bill',
  'utility_bill',
  'unknown',
] as const

export type DocumentAnalysisKind = (typeof DOCUMENT_ANALYSIS_KINDS)[number]

/**
 * Endereço extraído e normalizado de forma conservadora. O valor bruto fica em
 * `raw`; os campos normalizados usam `normalizeLogradouro`, `normalizeNumero`,
 * `normalizeCep` e `normalizeUf`. `null` significa "não extraído", nunca
 * "não confere".
 */
export interface ExtractedAddress {
  readonly logradouro: string | null
  readonly numero: string | null
  readonly complemento: string | null
  readonly bairro: string | null
  readonly cidade: string | null
  readonly uf: string | null
  readonly cep: string | null
  readonly raw: string
}

/**
 * Titular extraído. `name` só vem de um rótulo claro.
 *
 * O F1.2 **não persiste CPF/CNPJ**: o identificador fiscal é PII e a
 * necessidade de armazená-lo pertence à verificação (F1.3/F2), que pode
 * comparar com o `subject` ou decidir por uma representação derivada. O
 * analyzer não valida nem guarda o número.
 */
export interface ExtractedHolder {
  readonly name: string | null
  readonly raw: string
}

export interface DocumentAnalysisDocument {
  readonly status: DocumentAnalysisDocumentStatus
  readonly kind: DocumentAnalysisKind
  readonly issuedAt: string | null
  readonly issuedRaw: string | null
}

export interface DocumentAnalysisDimension<T> {
  readonly status: DocumentAnalysisExtractionStatus
  /** `null` se não extraído/unknown; o valor só existe com status `extracted`. */
  readonly value: T | null
  /** Trecho bruto mínimo usado para auditoria; nunca o texto inteiro. */
  readonly raw: string | null
}

export interface DocumentAnalysisResult {
  readonly contractVersion: string
  readonly analyzer: {
    readonly id: string
    readonly version: string
  }
  readonly status: DocumentAnalysisTerminalStatus
  readonly document: DocumentAnalysisDocument
  readonly address: DocumentAnalysisDimension<ExtractedAddress>
  readonly holder: DocumentAnalysisDimension<ExtractedHolder>
  /**
   * Referência fiscal extraída do QR do próprio artefato (F2.2b). É uma
   * observação não confiável, não prova autenticidade e não autoriza fetch.
   *
   * O resultado persistido deve ter `url = null`: a URL do QR é removida antes
   * de gravar (o `fingerprint` e o `documentId` permanecem). `null` significa
   * que a extração física não foi executada (ex.: PDF inválido); os estados
   * `not_found`/`inconclusive`/`unsupported` são explícitos no contrato da
   * referência.
   */
  readonly fiscalReference: FiscalReference | null
  readonly limitations: readonly string[]
  readonly errorCodes: readonly string[]
  readonly analyzedAt: string
}

export const isTerminalDocumentAnalysisStatus = (
  status: DocumentAnalysisStatus,
): status is DocumentAnalysisTerminalStatus => status !== 'pending' && status !== 'analyzing'
