import { PROBLEM_CONTENT_TYPE, problems } from '@comprova/contracts'
import type { FastifyReply } from 'fastify'
import { eraseSubject, listSubjectValidations } from './subjects.service.js'
import type { Db } from '@comprova/db'

export interface SubjectControllerDeps {
  readonly db: Db
}

export const makeSubjectController = (deps: SubjectControllerDeps) => ({
  listValidations: async (tenantId: string | undefined, subjectId: string, reply: FastifyReply) => {
    if (tenantId === undefined) throw new Error('tenant context missing')
    const result = await listSubjectValidations(deps.db, tenantId, subjectId)
    if (!result.found) {
      return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound('subject'))
    }
    return reply.send({
      subject_id: subjectId,
      validations: result.validations.map((validation) => ({
        validation_id: validation.validationId,
        status: validation.status,
        verdict: validation.verdict,
        created_at: validation.createdAt.toISOString(),
        expires_at: validation.expiresAt.toISOString(),
        legal_basis: validation.legalBasis,
        consent_ref: validation.consentRef,
      })),
    })
  },

  erase: async (
    tenantId: string | undefined,
    apiKeyId: string | undefined,
    subjectId: string,
    reply: FastifyReply,
  ) => {
    if (tenantId === undefined || apiKeyId === undefined) throw new Error('tenant context missing')
    const erased = await eraseSubject(deps.db, tenantId, apiKeyId, subjectId)
    if (erased === null) {
      return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound('subject'))
    }
    return reply.send({ erased: true, validations_removed: erased })
  },
})
