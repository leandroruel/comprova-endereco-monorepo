import { randomUUID } from 'node:crypto'
import {
  DocumentIntelligenceResponseSchema,
  PROBLEM_CONTENT_TYPE,
  problems,
  type Problem,
} from '@comprova/contracts'
import type { Logger } from '@comprova/observability'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  DocumentIntelligenceError,
  type DocumentIntelligenceClient,
} from '../../services/document-intelligence-client.js'
import { requireWriteScope } from '../../plugins/scope.js'
import {
  EVIDENCE_MULTIPART_OVERHEAD_BYTES,
  EvidenceMultipartError,
  isMultipartError,
  readEvidenceFile,
} from '../validations/evidence-intake.multipart.js'

export interface DocumentRoutesDeps {
  readonly client: DocumentIntelligenceClient
  /** Limite real do PDF (o multipart do Fastify também limita). */
  readonly maxBytes: number
  readonly logger: Logger
}

const sendProblem = (reply: FastifyReply, value: Problem): FastifyReply =>
  reply.code(value.status).type(PROBLEM_CONTENT_TYPE).send(value)

const parseContentLength = (value: string | undefined): number | null => {
  if (value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

const multipartProblem = (error: EvidenceMultipartError): Problem => {
  switch (error.reason) {
    case 'too_large':
      return problems.evidenceTooLarge()
    case 'missing_file':
      return problems.evidenceFileRequired()
    case 'too_many_parts':
    case 'malformed':
      return problems.invalidMultipart()
  }
}

const clientProblem = (error: DocumentIntelligenceError): Problem => {
  switch (error.kind) {
    case 'empty':
      return problems.evidenceEmpty()
    case 'too_large':
      return problems.evidenceTooLarge()
    case 'rejected':
      // Entrada inválida do chamador: não-PDF, corrompido, criptografado ou
      // acima do limite de páginas (HTTP 400/422 do serviço).
      return problems.invalidDocument()
    case 'timeout':
      return problems.documentIntelligenceTimeout()
    case 'invalid_response':
      return problems.documentIntelligenceInvalidResponse()
    case 'upstream_error':
      return problems.documentParsingFailed()
    case 'not_configured':
    case 'unavailable':
      return problems.documentIntelligenceUnavailable()
  }
}

const handleError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof DocumentIntelligenceError) return sendProblem(reply, clientProblem(error))
  if (error instanceof EvidenceMultipartError) return sendProblem(reply, multipartProblem(error))
  if (isMultipartError(error)) return sendProblem(reply, problems.invalidMultipart())
  throw error
}

/**
 * Rota opcional que encaminha um PDF já lido para o serviço Document
 * Intelligence e devolve o contrato estruturado. O fluxo de validação
 * (evidence-intake) continua intocado; esta rota serve para consumo direto e
 * para comprovar a integração HTTP.
 */
export const registerDocumentRoutes = (instance: FastifyInstance, deps: DocumentRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()

  app.post(
    '/documents/parse',
    {
      preHandler: requireWriteScope,
      schema: {
        response: {
          200: DocumentIntelligenceResponseSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const contentLength = parseContentLength(request.headers['content-length'])
      if (contentLength !== null && contentLength > deps.maxBytes + EVIDENCE_MULTIPART_OVERHEAD_BYTES) {
        return sendProblem(reply, problems.evidenceTooLarge())
      }

      try {
        const file = await readEvidenceFile(request, deps.maxBytes)
        const documentId = randomUUID()
        const result = await deps.client.parsePdf({
          data: file.data,
          filename: file.filename,
          documentId,
        })
        if (result.status === 'failed') {
          deps.logger.warn({ documentId, errorCode: result.errorCode }, 'document_intelligence_parse_failed')
          return sendProblem(reply, problems.documentParsingFailed())
        }
        return reply.code(200).send(result)
      } catch (error) {
        return handleError(reply, error)
      }
    },
  )
}
