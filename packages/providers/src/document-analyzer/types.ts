import type { DebugTraceSink } from '../debug-trace.js'
import type { DocumentAnalysisResult } from '@comprova/core'
import type { DocumentIntelligenceClient } from '../document-intelligence/client.js'

export interface DocumentAnalyzerInput {
  readonly data: Uint8Array
  readonly contentType: string
}

export interface DocumentAnalyzer {
  readonly id: string
  readonly version: string
  readonly contractVersion: string
  readonly analyze: (input: DocumentAnalyzerInput) => Promise<DocumentAnalysisResult>
}

export interface DocumentAnalyzerOptions {
  readonly now?: () => Date
  /** Diagnóstico opcional; o trace não altera a decisão do analyzer. */
  readonly trace?: DebugTraceSink
  /** Cliente do serviço Document Intelligence (Marker). Quando ausente, o
   * analyzer usa apenas a camada local (unpdf) — sem chamadas externas. */
  readonly documentIntelligence?: DocumentIntelligenceClient | null
}

/** Sinaliza indisponibilidade do analisador/provider, não documento inválido. */
export class DocumentAnalyzerUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`document analyzer unavailable: ${reason}`)
    this.name = 'DocumentAnalyzerUnavailableError'
  }
}
