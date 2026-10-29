import { PROBLEM_CONTENT_TYPE, problem } from '@comprova/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { EvidenceMultipartError, readEvidenceFile } from '../validations/evidence-intake.multipart.js'
import { extractFiscalReferenceFromArtifact, type DebugTraceEvent } from '@comprova/providers'
import type { FiscalReference } from '@comprova/core'

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
  app.addHook('preHandler', requireWriteScope)

  app.post(
    '/debug/nf3e/qrcode',
    {
      bodyLimit: DEBUG_MAX_BYTES,
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

      let reference: FiscalReference
      try {
        reference = await extractFiscalReferenceFromArtifact(
          { data: file.data, contentType: file.mimetype },
          { onDebug: sink },
        )
      } catch {
        return sendProblem(reply, 500, 'INTERNAL_ERROR', 'Falha ao extrair referência fiscal do artefato')
      }

      return reply.code(200).send({
        events,
        reference,
      })
    },
  )
}
