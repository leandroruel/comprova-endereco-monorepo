import { PROBLEM_CONTENT_TYPE, problem } from '@comprova/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { EvidenceMultipartError, readEvidenceFile } from '../validations/evidence-intake.multipart.js'
import {
  extractFiscalReferenceFromArtifact,
  makeDocumentAnalyzer,
  type DebugTraceEvent,
} from '@comprova/providers'
import type { DocumentAnalysisResult, FiscalReference } from '@comprova/core'

const DEBUG_MAX_BYTES = 10 * 1024 * 1024 // 10 MB — suficiente para comprovantes

const acceptedContentTypes = new Set(['application/pdf', 'image/jpeg', 'image/png'])

const collectSink = (): {
  readonly events: DebugTraceEvent[]
  readonly sink: (event: {
    readonly code: string
    readonly level: 'info' | 'success' | 'warning' | 'error'
    readonly message: string
    readonly details?: Readonly<Record<string, unknown>>
  }) => void
} => {
  const events: DebugTraceEvent[] = []
  const sink = (event: DebugTraceEvent): void => {
    events.push(event)
  }
  return { events, sink }
}

const sendProblem = (reply: FastifyReply, status: number, code: string, message: string): FastifyReply =>
  reply
    .code(status)
    .type(PROBLEM_CONTENT_TYPE)
    .send(problem(status, code, message))

export const registerDebugNf3eQrCodeRoute = (
  app: FastifyInstance,
  requireWriteScope: (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>,
): void => {
  // Guard no nível da rota: `addHook` no mesmo contexto do `v1` vazaria o
  // scope de escrita para TODAS as rotas do plugin (inclusive leituras).
  app.post(
    '/debug/nf3e/qrcode',
    {
      bodyLimit: DEBUG_MAX_BYTES,
      preHandler: requireWriteScope,
    },
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      let file: { readonly data: Buffer; readonly mimetype: string }
      try {
        file = await readEvidenceFile(request, DEBUG_MAX_BYTES)
      } catch (error) {
        if (error instanceof EvidenceMultipartError) {
          switch (error.reason) {
            case 'too_large':
              return sendProblem(reply, 413, 'EVIDENCE_TOO_LARGE', 'Arquivo excede o limite de 10 MB')
            case 'missing_file':
              return sendProblem(reply, 400, 'EVIDENCE_FILE_REQUIRED', 'Nenhum arquivo enviado')
            case 'too_many_parts':
            case 'malformed':
              return sendProblem(reply, 400, 'INVALID_MULTIPART', 'Multipart malformado')
          }
        }
        return sendProblem(reply, 400, 'EVIDENCE_READ_ERROR', 'Não foi possível ler o arquivo enviado')
      }

      if (!acceptedContentTypes.has(file.mimetype)) {
        return sendProblem(
          reply,
          415,
          'UNSUPPORTED_EVIDENCE_TYPE',
          'Tipo de arquivo não suportado. Envie PDF, JPEG ou PNG.',
        )
      }

      const { events, sink } = collectSink()

      // O PDF.js pode destacar (detach) o ArrayBuffer depois do parse. Como a
      // rota roda duas extrações sobre o mesmo upload (referência fiscal e
      // campos), cada parser recebe uma cópia independente dos bytes.
      const referenceData = Uint8Array.from(file.data)
      const analysisData = Uint8Array.from(file.data)

      let reference: FiscalReference
      try {
        reference = await extractFiscalReferenceFromArtifact(
          { data: referenceData, contentType: file.mimetype },
          { onDebug: sink },
        )
      } catch {
        return sendProblem(reply, 500, 'INTERNAL_ERROR', 'Falha ao extrair referência fiscal do artefato')
      }

      // O debugger é o lugar para inspecionar também a extração de campos do
      // F1.2. É o mesmo analisador usado pelo worker; a rota apenas o executa
      // sobre o mesmo artefato e expõe o resultado (sem persistir nada).
      // Para imagens o analyzer repetiria a leitura de QR sem produzir
      // titular/endereço (OCR ainda não implementado), então só roda em PDF.
      let analysis: DocumentAnalysisResult | null = null
      if (file.mimetype === 'application/pdf') {
        try {
          analysis = await makeDocumentAnalyzer().analyze({
            data: analysisData,
            contentType: file.mimetype,
          })
        } catch {
          analysis = null
        }
      } else {
        events.push({
          code: 'ANALYSIS_SKIPPED',
          level: 'info',
          message: 'Extração de titular/endereço só é executada para PDF',
        })
      }

      if (analysis === null) {
        if (file.mimetype === 'application/pdf') {
          events.push({
            code: 'ANALYSIS_FAILED',
            level: 'warning',
            message: 'Análise de titular/endereço não pôde ser executada',
          })
        }
      } else {
        const { holder, address } = analysis
        if (holder.status === 'extracted' && holder.value !== null) {
          events.push({
            code: 'HOLDER_EXTRACTED',
            level: 'success',
            message: `Titular extraído: ${holder.value.name ?? '—'}`,
            details: { name: holder.value.name },
          })
        } else {
          events.push({
            code: 'HOLDER_NOT_EXTRACTED',
            level: 'warning',
            message: 'Titular não extraído: rótulo ausente ou ambíguo',
          })
        }
        if (address.status === 'extracted' && address.value !== null) {
          events.push({
            code: 'ADDRESS_EXTRACTED',
            level: 'success',
            message: 'Endereço extraído',
            details: {
              logradouro: address.value.logradouro,
              numero: address.value.numero,
              complemento: address.value.complemento,
              bairro: address.value.bairro,
              cidade: address.value.cidade,
              uf: address.value.uf,
              cep: address.value.cep,
            },
          })
        } else {
          events.push({
            code: 'ADDRESS_NOT_EXTRACTED',
            level: 'warning',
            message: 'Endereço não extraído: rótulo ausente ou ambíguo',
          })
        }
      }

      return reply.code(200).send({
        events,
        reference,
        analysis:
          analysis === null
            ? null
            : {
                status: analysis.status,
                document: analysis.document,
                holder: analysis.holder,
                address: analysis.address,
                limitations: analysis.limitations,
                errorCodes: analysis.errorCodes,
              },
      })
    },
  )
}
