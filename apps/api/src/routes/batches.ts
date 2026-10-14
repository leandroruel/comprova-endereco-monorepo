import { and, eq } from '@comprova/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { PROBLEM_CONTENT_TYPE, ProblemSchema, problems } from '@comprova/contracts'
import type { Db } from '@comprova/db'
import { withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { randomUUID } from 'node:crypto'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'

const CreateBatchSchema = z.object({
  items: z
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

export interface BatchRoutesDeps {
  readonly db: Db
}

export const registerBatchRoutes = (instance: FastifyInstance, deps: BatchRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()

  app.post(
    '/batches',
    {
      schema: {
        body: CreateBatchSchema,
        response: {
          202: z.object({
            batch_id: z.uuid(),
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
      const batchId = randomUUID()
      const items = body.items.map((item, position) => ({
        itemId: randomUUID(),
        batchId,
        tenantId: tenant.tenantId,
        position,
        docType: item.type,
        docDigits: item.value.replace(/\D+/g, ''),
        status: 'pending',
      }))
      await withTenant(deps.db, tenant.tenantId, async (tx) => {
        await tx.insert(t.batch).values({
          batchId,
          tenantId: tenant.tenantId,
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
    '/batches/:id',
    {
      schema: {
        params: z.object({ id: z.uuid() }),
        response: {
          200: z.object({
            batch_id: z.uuid(),
            status: z.string(),
            total_items: z.number().int(),
            items: z.array(
              z.object({
                position: z.number().int(),
                doc_type: z.string(),
                status: z.string(),
                validation_id: z.uuid().nullable(),
                error_code: z.string().nullable(),
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
          })
          .from(t.batchItem)
          .where(eq(t.batchItem.batchId, batch.batchId))
          .orderBy(t.batchItem.position)
          .limit(100),
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
        })),
      })
    },
  )
}
