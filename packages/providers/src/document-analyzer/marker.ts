/**
 * F1.2 — adapter do serviço Document Intelligence (Marker).
 *
 * Responsabilidades:
 * - chamar o cliente HTTP existente (sem duplicar implementação de rede);
 * * validar a resposta com o contrato existente (`DocumentIntelligenceResponseSchema`);
 * - mapear erros do serviço para erros tipados do adapter (timeout, indisponível,
 *   não suportado, sem texto, falha de parsing, resultado parcial);
 * - extrair texto ordenado de leitura e tabelas do JSON estruturado;
 * - emitir eventos de trace (`marker.*`) sem alterar a decisão do analyzer.
 *
 * O adapter NÃO decide autenticidade, correspondência nem validade. Ele apenas
 * fornece texto/layout do Marker. O extrator de QR/referência fiscal continua
 * no caminho determinístico existente e nunca passa pelo OCR do Marker.
 */

import type {
  DocumentIntelligenceClient,
  DocumentIntelligenceError,
} from '../document-intelligence/client.js'
import { emitDebug, type DebugTraceSink } from '../debug-trace.js'
import {
  type DocumentIntelligenceElement,
  type DocumentIntelligencePage,
  type DocumentIntelligenceResponse,
  type DocumentIntelligenceTable,
} from '@comprova/contracts'

/**
 * Erros do adapter Marker. Cada kind é um código estável, em inglês, adequado
 * para filtros, testes e métricas.
 */
export class MarkerAdapterError extends Error {
  constructor(
    readonly kind:
      | 'not_configured'
      | 'timeout'
      | 'unavailable'
      | 'busy'
      | 'unsupported'
      | 'no_text'
      | 'parsing_failed'
      | 'partial',
    message: string,
  ) {
    super(message)
    this.name = 'MarkerAdapterError'
  }
}

const mapClientError = (error: DocumentIntelligenceError): MarkerAdapterError => {
  switch (error.kind) {
    case 'not_configured':
      return new MarkerAdapterError('not_configured', 'Document Intelligence não configurado')
    case 'timeout':
      return new MarkerAdapterError('timeout', 'Tempo limite excedido na chamada ao Marker')
    case 'unavailable':
      return new MarkerAdapterError('unavailable', 'Serviço Document Intelligence indisponível')
    case 'busy':
      // Capacidade esgotada do serviço (HTTP 429): transitório, o chamador
      // pode tentar novamente mais tarde. Nunca mapeia para indisponível.
      return new MarkerAdapterError('busy', 'Serviço Document Intelligence com capacidade esgotada')
    case 'too_large':
      return new MarkerAdapterError('unsupported', 'Documento excede o tamanho limite do serviço')
    case 'rejected':
      return new MarkerAdapterError(
        'unsupported',
        'Documento rejeitado pelo serviço (não-PDF, corrompido, criptografado)',
      )
    case 'empty':
      return new MarkerAdapterError('unsupported', 'Documento vazio')
    case 'invalid_response':
      return new MarkerAdapterError('parsing_failed', 'Resposta do Marker fora do contrato')
    case 'upstream_error':
      return new MarkerAdapterError('unavailable', 'Erro upstream do serviço Document Intelligence')
    default:
      return new MarkerAdapterError('unavailable', 'Falha na comunicação com o Document Intelligence')
  }
}

/**
 * Resultado do adapter Marker. `text` é a camada textual ordenada de leitura;
 * `tables` são as tabelas estruturadas; `provenance` alimenta o campo opcional
 * do contrato de análise.
 */
export interface MarkerParseResult {
  readonly text: string
  readonly tables: readonly DocumentIntelligenceTable[]
  readonly elements: readonly DocumentIntelligenceElement[]
  readonly pages: number
  readonly markerVersion: string
  readonly processingTimeMs: number
  readonly warnings: readonly string[]
}

const extractTextFromPages = (pages: readonly DocumentIntelligencePage[]): string => {
  const parts: string[] = []
  for (const page of pages) {
    for (const element of page.elements) {
      if (element.text && element.text.trim().length > 0) {
        parts.push(element.text)
      }
    }
  }
  return parts.join('\n')
}

const debugMarkerResult = (result: DocumentIntelligenceResponse): Record<string, unknown> => ({
  status: result.status,
  pageCount: result.document.pageCount,
  processor: result.metadata.processor,
  processorVersion: result.metadata.processorVersion,
  processingTimeMs: result.metadata.processingTimeMs,
  contractVersion: result.metadata.contractVersion,
  warnings: result.warnings,
  errorCode: result.errorCode,
  hasText: typeof result.content.text === 'string' && result.content.text.trim().length > 0,
  pages: result.pages.length,
})

/**
 * Cria o adapter Marker. O `client` é injetado (não instanciado aqui) para
 * evitar dependência circular e permitir testes com mock.
 */
export const makeMarkerAdapter = (
  client: DocumentIntelligenceClient,
): {
  readonly enabled: boolean
  readonly maxFileSizeBytes: number
  /** Faz o parse do PDF pelo Marker. Lança `MarkerAdapterError` em falha. */
  parse: (
    input: {
      readonly data: Uint8Array
      readonly filename: string
      readonly documentId: string
      readonly signal?: AbortSignal | undefined
    },
    trace?: DebugTraceSink,
  ) => Promise<MarkerParseResult>
} => {
  const enabled = client.enabled
  const maxFileSizeBytes = client.maxFileSizeBytes

  const parse = async (
    input: {
      readonly data: Uint8Array
      readonly filename: string
      readonly documentId: string
      readonly signal?: AbortSignal | undefined
    },
    trace?: DebugTraceSink,
  ): Promise<MarkerParseResult> => {
    if (!enabled) {
      const error = new MarkerAdapterError('not_configured', 'Document Intelligence não configurado')
      emitDebug(trace, {
        code: 'marker.not_configured',
        level: 'warning',
        message: 'Document Intelligence não configurado; usando camada local.',
      })
      throw error
    }

    const startedAt = Date.now()
    emitDebug(trace, {
      code: 'marker.call',
      level: 'info',
      message: 'Chamando o serviço Document Intelligence (Marker).',
      details: { documentId: input.documentId, filename: input.filename, bytes: input.data.byteLength },
    })

    let response: DocumentIntelligenceResponse
    try {
      response = await client.parsePdf(input)
    } catch (error) {
      if (error instanceof MarkerAdapterError) {
        emitDebug(trace, {
          code: 'marker.error',
          level: 'error',
          message: error.message,
          details: { kind: error.kind, documentId: input.documentId },
        })
        throw error
      }
      const mapped = mapClientError(error as DocumentIntelligenceError)
      emitDebug(trace, {
        code: 'marker.error',
        level: 'error',
        message: mapped.message,
        details: { kind: mapped.kind, documentId: input.documentId },
      })
      throw mapped
    }

    const durationMs = Date.now() - startedAt

    if (response.status === 'failed') {
      const error = new MarkerAdapterError(
        'parsing_failed',
        `Marker falhou no parsing do documento${response.errorMessage ? `: ${response.errorMessage}` : ''}`,
      )
      emitDebug(trace, {
        code: 'marker.error',
        level: 'error',
        message: error.message,
        details: debugMarkerResult(response),
      })
      throw error
    }

    const text = typeof response.content.text === 'string' ? response.content.text : ''
    const normalized = text.trim()
    const pagesText = extractTextFromPages(response.pages)
    const hasTables = response.pages.some((page) =>
      page.elements.some(
        (element) =>
          element.table !== null &&
          (element.table.headers.some((header) => header.trim().length > 0) ||
            element.table.rows.some((row) => row.some((cell) => cell.trim().length > 0))),
      ),
    )

    // Só considera que não há texto quando nem o conteúdo de leitura, o texto
    // das páginas nem as tabelas produziram algo utilizável.
    if (normalized.length === 0 && pagesText.trim().length === 0 && !hasTables) {
      const error = new MarkerAdapterError('no_text', 'Marker não extraiu texto utilizável do documento')
      emitDebug(trace, {
        code: 'marker.no_text',
        level: 'warning',
        message: 'Marker não retornou texto extraível.',
        details: debugMarkerResult(response),
      })
      throw error
    }

    // O texto do `content.text` já vem em ordem de leitura do Marker. Usamos
    // as páginas apenas quando o conteúdo está em branco e para contagem +
    // tabelas.
    const finalText = normalized.length > 0 ? normalized : pagesText

    emitDebug(trace, {
      code: 'marker.success',
      level: 'success',
      message: `Marker extraiu texto (${finalText.length} caracteres, ${response.document.pageCount} página(s)).`,
      details: {
        documentId: input.documentId,
        chars: finalText.length,
        pages: response.document.pageCount,
        tables: response.pages.reduce(
          (acc: number, p: DocumentIntelligencePage) =>
            acc + p.elements.filter((e: DocumentIntelligenceElement) => e.table !== null).length,
          0,
        ),
        durationMs,
      },
    })

    return {
      text: finalText,
      tables: response.pages.flatMap((p: DocumentIntelligencePage) =>
        p.elements
          .filter(
            (
              e: DocumentIntelligenceElement,
            ): e is DocumentIntelligenceElement & { readonly table: DocumentIntelligenceTable } =>
              e.table !== null,
          )
          .map((e: DocumentIntelligenceElement & { readonly table: DocumentIntelligenceTable }) => e.table),
      ),
      elements: response.pages.flatMap((p: DocumentIntelligencePage) => p.elements),
      pages: response.document.pageCount,
      markerVersion: response.metadata.processorVersion,
      processingTimeMs: response.metadata.processingTimeMs,
      warnings: response.warnings,
    }
  }

  return { enabled, maxFileSizeBytes, parse }
}
