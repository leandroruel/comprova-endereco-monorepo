import {
  DOCUMENT_ANALYSIS_CONTRACT_VERSION,
  DOCUMENT_ANALYZER_ID,
  DOCUMENT_ANALYZER_VERSION,
  type DocumentAnalysisResult,
} from '@comprova/core'
import { analyzeDocument } from './analyze.js'
import { failedResult } from './results.js'
import { documentAnalysisResultSchema } from './schema.js'
import { DocumentAnalyzerUnavailableError } from './types.js'
import type { DocumentAnalyzer, DocumentAnalyzerOptions } from './types.js'

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
 *   - `analyze.ts`: análise de PDF/texto e despacho por content-type.
 */

export { DocumentAnalyzerUnavailableError }
export type { DocumentAnalyzer, DocumentAnalyzerInput, DocumentAnalyzerOptions } from './types.js'
export { documentAnalysisResultSchema } from './schema.js'
export {
  failedResult as documentAnalysisFailedResult,
  unavailableResult as documentAnalysisUnavailableResult,
} from './results.js'

/**
 * MVP: um único analisador que decide pelo content-type já sniffado no intake.
 * Futuras implementações (OCR/VLM) implementam a mesma interface e são
 * injetadas no worker sem mudar o contrato persistido.
 */
export const makeDocumentAnalyzer = (options: DocumentAnalyzerOptions = {}): DocumentAnalyzer => {
  const now = options.now ?? (() => new Date())
  return {
    id: DOCUMENT_ANALYZER_ID,
    version: DOCUMENT_ANALYZER_VERSION,
    contractVersion: DOCUMENT_ANALYSIS_CONTRACT_VERSION,
    analyze: async (input) => {
      let result: DocumentAnalysisResult
      try {
        result = await analyzeDocument(input, now())
      } catch (error) {
        if (error instanceof DocumentAnalyzerUnavailableError) throw error
        result = failedResult(now(), 'ANALYZER_FAILED')
      }
      return documentAnalysisResultSchema.parse(result)
    },
  }
}
