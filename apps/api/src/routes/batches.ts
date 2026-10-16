import { and, desc, eq } from '@comprova/db'
import type { Db } from '@comprova/db'
import { withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { PROBLEM_CONTENT_TYPE, ProblemSchema, problems } from '@comprova/contracts'
import { digitsOnly } from '@comprova/core'
import { randomUUID } from 'node:crypto'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

export interface BatchRoutesDeps {
  readonly db: Db
}

const CreateBatchSchema = z.object({
  documents: z
    .array(
      z.object({
        type: z.enum(['CPF', 'CNPJ']),
        value: z.string().min(11).max(20),
      }),
    )
    .min(1)
    .max(1000),
  mode: z.enum(['fast', 'deep', 'auto']).default('fast'),
  legal_basis: z.enum(['FRAUD_PREVENTION', 'CONTRACT_EXECUTION', 'CONSENT']),
})

const BatchListDto = z.object({
  batches: z.array(
    z.object({
      batch_id: z.string(),
      status: z.string(),
      total_items: z.number().int(),
      completed: z.number().int(),
      failed: z.number().int(),
      created_at: z.string(),
      completed_at: z.string().nullable(),
    }),
  ),
})

export const registerBatchRoutes = (instance: FastifyInstance, deps: BatchRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()

  app.post(
    '/batches',
    {
      schema: {
        body: CreateBatchSchema,
        response: {
          202: z.object({
            batch_id: z.string(),
            total_items: z.number().int(),
            status: z.string(),
          }),
          422: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = request.tenant
      if (tenant === undefined) throw new Error('tenant context missing')
      const body = request.body
      if (body.mode !== 'fast') {
        return reply.code(422).type(PROBLEM_CONTENT_TYPE).send(problems.unprocessableAddress())
      }

      const documents = body.documents
      const batchId = randomUUID()
      const items = documents.map((item, position) => ({
        itemId: randomUUID(),
        batchId,
        tenantId: tenant.tenantId,
        position,
        docType: item.type,
        docDigits: digitsOnly(item.value),
        status: 'pending',
      }))

      await withTenant(deps.db, tenant.tenantId, async (tx) => {
        await tx.insert(t.batch).values({
          batchId,
          tenantId: tenant.tenantId,
          userId: request.sessionUser?.id ?? null,
          status: 'queued',
          totalItems: items.length,
          mode: body.mode,
          legalBasis: body.legal_basis,
        })
        await tx.insert(t.batchItem).values(items)
      })

      reply.header('Location', `/v1/batches/${batchId}`)
      return reply.code(202).send({
        batch_id: batchId,
        total_items: items.length,
        status: 'queued',
      })
    },
  )

  app.get(
    '/batches',
    {
      schema: {
        response: { 200: BatchListDto },
      },
    },
    async (request) => {
      const tenant = request.tenant
      if (tenant === undefined) throw new Error('tenant context missing')
      const userId = request.sessionUser?.id

      const rows = await withTenant(deps.db, tenant.tenantId, (tx) =>
        tx
          .select({
            batchId: t.batch.batchId,
            status: t.batch.status,
            totalItems: t.batch.totalItems,
            createdAt: t.batch.createdAt,
            completedAt: t.batch.completedAt,
          })
          .from(t.batch)
          .where(userId !== null && userId !== undefined ? eq(t.batch.userId, userId) : undefined)
          .orderBy(desc(t.batch.createdAt))
          .limit(20),
      )

      const batchIds = rows.map((r) => r.batchId)
      const items =
        batchIds.length > 0
          ? await withTenant(deps.db, tenant.tenantId, (tx) =>
              tx
                .select({
                  batchId: t.batchItem.batchId,
                  status: t.batchItem.status,
                })
                .from(t.batchItem),
            ).then((all) => all.filter((i) => batchIds.includes(i.batchId)))
          : []

      return {
        batches: rows.map((r) => ({
          batch_id: r.batchId,
          status: r.status,
          total_items: r.totalItems,
          completed: items.filter((i) => i.batchId === r.batchId && i.status === 'completed').length,
          failed: items.filter((i) => i.batchId === r.batchId && i.status === 'failed').length,
          created_at: r.createdAt.toISOString(),
          completed_at: r.completedAt?.toISOString() ?? null,
        })),
      }
    },
  )

  app.get(
    '/batches/:id',
    {
      schema: {
        params: z.object({ id: z.string() }),
        response: {
          200: z.object({
            batch_id: z.string(),
            status: z.string(),
            total_items: z.number().int(),
            items: z.array(
              z.object({
                position: z.number().int(),
                doc_type: z.string(),
                status: z.string(),
                validation_id: z.string().nullable(),
                error_code: z.string().nullable(),
                verdict: z.string().nullable(),
                confidence: z.number().nullable(),
                explanation: z.string().nullable(),
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
      const batchRows = await withTenant(deps.db, tenant.tenantId, (tx) =>
        tx
          .select({
            batchId: t.batch.batchId,
            status: t.batch.status,
            totalItems: t.batch.totalItems,
          })
          .from(t.batch)
          .where(and(eq(t.batch.batchId, request.params.id), eq(t.batch.tenantId, tenant.tenantId)))
          .limit(1),
      )
      const batch = batchRows[0]
      if (batch === undefined) {
        return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound('batch'))
      }
      const items = await withTenant(deps.db, tenant.tenantId, (tx) =>
        tx
          .select({
            position: t.batchItem.position,
            docType: t.batchItem.docType,
            status: t.batchItem.status,
            validationId: t.batchItem.validationId,
            errorCode: t.batchItem.errorCode,
            verdict: t.batchItem.verdict,
            confidence: t.batchItem.confidence,
            explanation: t.batchItem.explanation,
          })
          .from(t.batchItem)
          .where(eq(t.batchItem.batchId, batch.batchId))
          .orderBy(t.batchItem.position),
      )
      return reply.send({
        batch_id: batch.batchId,
        status: batch.status,
        total_items: batch.totalItems,
        items: items.map((i) => ({
          position: i.position,
          doc_type: i.docType,
          status: i.status,
          validation_id: i.validationId,
          error_code: i.errorCode,
          verdict: i.verdict,
          confidence: i.confidence,
          explanation: i.explanation,
        })),
      })
    },
  )

  app.get(
    '/batches/:id/export',
    {
      schema: {
        params: z.object({ id: z.string() }),
        querystring: z.object({ format: z.enum(['csv', 'json']).default('csv') }),
      },
    },
    async (request, reply) => {
      const tenant = request.tenant
      if (tenant === undefined) throw new Error('tenant context missing')

      const batch = await withTenant(deps.db, tenant.tenantId, (tx) =>
        tx
          .select({ batchId: t.batch.batchId })
          .from(t.batch)
          .where(eq(t.batch.batchId, request.params.id))
          .limit(1),
      )
      if (batch.length === 0) {
        return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound('batch'))
      }

      const items = await withTenant(deps.db, tenant.tenantId, (tx) =>
        tx
          .select({
            position: t.batchItem.position,
            docType: t.batchItem.docType,
            docDigits: t.batchItem.docDigits,
            status: t.batchItem.status,
            verdict: t.batchItem.verdict,
            confidence: t.batchItem.confidence,
            explanation: t.batchItem.explanation,
            errorCode: t.batchItem.errorCode,
          })
          .from(t.batchItem)
          .where(eq(t.batchItem.batchId, request.params.id))
          .orderBy(t.batchItem.position),
      )

      if (request.query.format === 'json') {
        reply.header('content-type', 'application/json')
        reply.header('content-disposition', `attachment; filename="batch-${request.params.id}.json"`)
        return reply.send(
          JSON.stringify(
            items.map((i) => ({
              position: i.position,
              document_type: i.docType,
              document: i.docDigits,
              status: i.status,
              verdict: i.verdict,
              confidence: i.confidence,
              explanation: i.explanation,
              error_code: i.errorCode,
            })),
            null,
            2,
          ),
        )
      }

      const header = 'posicao,tipo_documento,documento,status,veredito,confianca,explicacao,erro'
      const lines = items.map((i) => {
        const conf = i.confidence !== null ? (i.confidence * 100).toFixed(0) + '%' : ''
        const expl = (i.explanation ?? '').replace(/"/g, '""').replace(/\n/g, ' ')
        const err = i.errorCode ?? ''
        return `${i.position},${i.docType},${i.docDigits},${i.status},${i.verdict ?? ''},${conf},"${expl}",${err}`
      })
      reply.header('content-type', 'text/csv; charset=utf-8')
      reply.header('content-disposition', `attachment; filename="batch-${request.params.id}.csv"`)
      return reply.send([header, ...lines].join('\n'))
    },
  )
}
