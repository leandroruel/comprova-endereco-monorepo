import { PROBLEM_CONTENT_TYPE, problems, type Problem } from '@comprova/contracts'
import type { Db } from '@comprova/db'
import type { Logger } from '@comprova/observability'
import type { ObjectStore } from '@comprova/providers'
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  EvidenceMultipartError,
  EVIDENCE_MULTIPART_OVERHEAD_BYTES,
  isMultipartError,
  readEvidenceFile,
} from './evidence-intake.multipart.js'
import { EvidenceIntakeError, uploadEvidence, type EvidenceIntakeResult } from './evidence-intake.service.js'
import type { TenantContext } from '../../plugins/auth.js'
import { makeSemaphore } from '../../shared/semaphore.js'

export interface EvidenceIntakeControllerDeps {
  readonly db: Db
  readonly objectStore: ObjectStore
  readonly evidenceMaxBytes: number
  readonly evidenceMaxConcurrency: number
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

const sendIntakeError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof EvidenceIntakeError) return sendProblem(reply, error.problem)
  if (error instanceof EvidenceMultipartError) return sendProblem(reply, multipartProblem(error))
  if (isMultipartError(error)) return sendProblem(reply, problems.invalidMultipart())
  throw error
}

const responseOf = (
  result: EvidenceIntakeResult,
): {
  readonly evidence_id: string
  readonly artifact_id: string
  readonly status: 'pending'
} => ({
  evidence_id: result.evidenceId,
  artifact_id: result.artifactId,
  status: result.status,
})

export interface EvidenceIntakeController {
  readonly upload: (
    tenant: TenantContext | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<FastifyReply>
}

export const makeEvidenceIntakeController = (
  deps: EvidenceIntakeControllerDeps,
): EvidenceIntakeController => {
  const uploadSemaphore = makeSemaphore(deps.evidenceMaxConcurrency)

  return {
    upload: async (tenant, request, reply) => {
      if (tenant === undefined) return sendProblem(reply, problems.unauthorized())

      const contentLength = parseContentLength(request.headers['content-length'])
      if (
        contentLength !== null &&
        contentLength > deps.evidenceMaxBytes + EVIDENCE_MULTIPART_OVERHEAD_BYTES
      ) {
        return sendProblem(reply, problems.evidenceTooLarge())
      }

      // Adquirido depois de auth/escopo e do precheck de Content-Length, mas
      // antes de `readEvidenceFile`: é ali que `part.toBuffer()` retém até
      // `EVIDENCE_MAX_BYTES` por requisição. O release cobre sucesso, replay,
      // 4xx e 5xx.
      const release = await uploadSemaphore.acquire()
      try {
        const validationId = (request.params as { readonly id?: unknown }).id
        if (typeof validationId !== 'string') return sendProblem(reply, problems.notFound('validation'))
        const rawIdempotencyKey = request.headers['idempotency-key']
        const idempotencyKey = Array.isArray(rawIdempotencyKey) ? rawIdempotencyKey[0] : rawIdempotencyKey
        const file = await readEvidenceFile(request, deps.evidenceMaxBytes)
        const result = await uploadEvidence(
          {
            db: deps.db,
            store: deps.objectStore,
            logger: deps.logger,
            maxBytes: deps.evidenceMaxBytes,
          },
          {
            tenantId: tenant.tenantId,
            validationId,
            data: file.data,
            declaredContentType: file.mimetype,
            idempotencyKey,
          },
        )
        if (result.replayed) reply.header('Idempotent-Replayed', 'true')
        return reply.code(result.replayed ? 200 : 201).send(responseOf(result))
      } catch (error) {
        return sendIntakeError(reply, error)
      } finally {
        release()
      }
    },
  }
}
