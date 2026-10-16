import { and, eq, inArray } from '@comprova/db'
import type { Db } from '@comprova/db'
import { withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { PROBLEM_CONTENT_TYPE, ProblemSchema, problems } from '@comprova/contracts'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

export interface SubjectRoutesDeps {
  readonly db: Db
}

export const registerSubjectRoutes = (instance: FastifyInstance, deps: SubjectRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()

  app.get(
    '/subjects/:id/validations',
    {
      schema: {
        params: z.object({ id: z.uuid() }),
        response: {
          200: z.object({
            subject_id: z.uuid(),
            validations: z.array(
              z.object({
                validation_id: z.uuid(),
                status: z.string(),
                verdict: z.string().nullable(),
                created_at: z.string(),
                expires_at: z.string(),
                legal_basis: z.string(),
                consent_ref: z.string().nullable(),
              }),
            ),
          }),
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = request.tenant
      if (tenant === undefined) throw new Error('tenant context missing')
      const rows = await withTenant(deps.db, tenant.tenantId, (tx) =>
        tx
          .select({
            validationId: t.validation.validationId,
            status: t.validation.status,
            verdict: t.validation.verdict,
            createdAt: t.validation.createdAt,
            expiresAt: t.validation.expiresAt,
            legalBasis: t.validation.legalBasis,
            consentRef: t.validation.consentRef,
          })
          .from(t.validation)
          .innerJoin(t.subject, eq(t.validation.subjectId, t.subject.subjectId))
          .where(and(eq(t.subject.subjectId, request.params.id), eq(t.subject.tenantId, tenant.tenantId))),
      )
      if (rows.length === 0) {
        const subject = await withTenant(deps.db, tenant.tenantId, (tx) =>
          tx
            .select({ subjectId: t.subject.subjectId })
            .from(t.subject)
            .where(eq(t.subject.subjectId, request.params.id))
            .limit(1),
        )
        if (subject.length === 0) {
          return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound('subject'))
        }
      }
      return reply.send({
        subject_id: request.params.id,
        validations: rows.map((r) => ({
          validation_id: r.validationId,
          status: r.status,
          verdict: r.verdict,
          created_at: r.createdAt.toISOString(),
          expires_at: r.expiresAt.toISOString(),
          legal_basis: r.legalBasis,
          consent_ref: r.consentRef,
        })),
      })
    },
  )

  app.delete(
    '/subjects/:id',
    {
      schema: {
        params: z.object({ id: z.uuid() }),
        response: {
          200: z.object({ erased: z.boolean(), validations_removed: z.number().int() }),
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = request.tenant
      if (tenant === undefined) throw new Error('tenant context missing')
      const result = await withTenant(deps.db, tenant.tenantId, async (tx) => {
        const subject = await tx
          .select({ subjectId: t.subject.subjectId })
          .from(t.subject)
          .where(eq(t.subject.subjectId, request.params.id))
          .limit(1)
        if (subject.length === 0) return null

        const validations = await tx
          .select({ validationId: t.validation.validationId })
          .from(t.validation)
          .where(eq(t.validation.subjectId, request.params.id))
        const validationIds = validations.map((v) => v.validationId)

        if (validationIds.length > 0) {
          const claims = await tx
            .select({ claimId: t.claim.claimId })
            .from(t.claim)
            .where(inArray(t.claim.validationId, validationIds))
          if (claims.length > 0) {
            await tx.delete(t.claimEvidence).where(
              inArray(
                t.claimEvidence.claimId,
                claims.map((c) => c.claimId),
              ),
            )
          }
          await tx.delete(t.claim).where(inArray(t.claim.validationId, validationIds))
          await tx.delete(t.signal).where(inArray(t.signal.validationId, validationIds))
        }
        await tx
          .delete(t.validationIdempotency)
          .where(
            validationIds.length > 0
              ? inArray(t.validationIdempotency.validationId, validationIds)
              : eq(t.validationIdempotency.validationId, request.params.id),
          )
        await tx.delete(t.validation).where(eq(t.validation.subjectId, request.params.id))
        await tx.delete(t.subject).where(eq(t.subject.subjectId, request.params.id))

        await tx.insert(t.auditLog).values({
          tenantId: tenant.tenantId,
          actor: `api-key:${tenant.apiKeyId}`,
          action: 'subject.erasure',
          targetType: 'subject',
          targetId: request.params.id,
          details: { validations_removed: validationIds.length },
        })
        await tx.insert(t.outbox).values({
          aggregate: 'subject',
          aggregateId: request.params.id,
          eventType: 'subject.erased',
          payload: {
            tenant_id: tenant.tenantId,
            subject_id: request.params.id,
            validations_removed: validationIds.length,
          },
        })
        return validationIds.length
      })

      if (result === null) {
        return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound('subject'))
      }
      return reply.send({ erased: true, validations_removed: result })
    },
  )
}
