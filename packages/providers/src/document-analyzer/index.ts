import {
  DOCUMENT_ANALYSIS_CONTRACT_VERSION,
  DOCUMENT_ANALYZER_ID,
  DOCUMENT_ANALYZER_VERSION,
  type DocumentAnalysisResult,
} from '@comprova/core'
import { analyzeDocument, type MarkerAdapter } from './analyze.js'
import { makeMarkerAdapter } from './marker.js'
import { failedResult } from './results.js'
import { documentAnalysisResultSchema } from './schema.js'
import { emitDebug } from '../debug-trace.js'
import { DocumentAnalyzerUnavailableError, type DocumentAnalyzer, type DocumentAnalyzerInput, type DocumentAnalyzerOptions } from './types.js'

/**
 * F1.2 — analisador de documento.
 *
 * O contrato é o mesmo para qualquer implementação futura (PDF textual, OCR,
 * VLM). A implementação MVP extrai texto de PDF localmente; imagens retornam
 * `unsupported` com `OCR_NOT_IMPLEMENTED` (nenhum provider externo é acionado).
 *
 * O resultado é uma **observação não confiável**. O analisador nunca decide
 * `authentic` nem `matches`/`differs`: isso é responsabilidade do verificador
 * (F1.3/F2).
 *
 * O módulo é dividido em:
 *   - `types.ts`: protocolo público e erro de indisponibilidade;
 *   - `schema.ts`: validação do resultado persistido;
 *   - `fields.ts`: extração/normalização de endereço, titular e competência;
 *   - `results.ts`: construtores dos resultados terminais;
 *   - `analyze.ts`: análise de PDF/texto e despacho por content-type;
 *   - `marker.ts`: adapter do serviço Document Intelligence;
 *   - `structured.ts`: extração de tabelas e blocos.
 */

export { DocumentAnalyzerUnavailableError }
export type { DocumentAnalyzer, DocumentAnalyzerInput, DocumentAnalyzerOptions } from './types.js'
export { documentAnalysisResultSchema } from './schema.js'
export {
  failedResult as documentAnalysisFailedResult,
  unavailableResult as documentAnalysisUnavailableResult,
} from './results.js'

/**
 * Cria o analyzer. Quando `options.documentIntelligence` é fornecido, o
 * adapter Marker é criado e usado para complementar a camada local (unpdf)
 * quando ela não entrega titular e endereço. Quando ausente, o analyzer usa
 * apenas `unpdf`.
 */
export const makeDocumentAnalyzer = (options: DocumentAnalyzerOptions = {}): DocumentAnalyzer => {
  const now = options.now ?? (() => new Date())
  const trace = options.trace

  let markerAdapter: MarkerAdapter | null = null
  if (options.documentIntelligence !== undefined && options.documentIntelligence !== null) {
    markerAdapter = makeMarkerAdapter(options.documentIntelligence)
  }

  return {
    id: DOCUMENT_ANALYZER_ID,
    version: DOCUMENT_ANALYZER_VERSION,
    contractVersion: DOCUMENT_ANALYSIS_CONTRACT_VERSION,
    analyze: async (input: DocumentAnalyzerInput) => {
      let result: DocumentAnalysisResult
      try {
        result = await analyzeDocument(input, now(), trace, markerAdapter)
      } catch (error) {
        if (error instanceof DocumentAnalyzerUnavailableError) throw error
        emitDebug(trace, {
          code: 'analyzer.failed',
          level: 'error',
          message: 'O analyzer falhou inesperadamente.',
          details: { reason: error instanceof Error ? error.message : String(error) },
        })
        result = failedResult(now(), 'ANALYZER_FAILED')
      }
      return documentAnalysisResultSchema.parse(result)
    },
  }
}
