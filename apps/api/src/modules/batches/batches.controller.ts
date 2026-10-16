import { PROBLEM_CONTENT_TYPE, problems } from '@comprova/contracts'
import type { Db } from '@comprova/db'
import type { FastifyReply } from 'fastify'
import { createBatch, getBatch, getBatchExport, listBatches } from './batches.service.js'
import type { CreateBatchBody } from './batches.schema.js'

export interface BatchControllerDeps {
  readonly db: Db
}

export const makeBatchController = (deps: BatchControllerDeps) => ({
  create: async (
    tenantId: string | undefined,
    userId: string | null | undefined,
    body: CreateBatchBody,
    reply: FastifyReply,
  ) => {
    if (tenantId === undefined) throw new Error('tenant context missing')
    if (body.mode !== 'fast') {
      return reply.code(422).type(PROBLEM_CONTENT_TYPE).send(problems.unprocessableAddress())
    }
    const result = await createBatch(deps.db, tenantId, userId ?? null, body)
    reply.header('Location', `/v1/batches/${result.batchId}`)
    return reply.code(202).send({
      batch_id: result.batchId,
      total_items: result.totalItems,
      status: 'queued',
    })
  },

  list: async (tenantId: string | undefined, userId: string | undefined) => {
    if (tenantId === undefined) throw new Error('tenant context missing')
    return { batches: await listBatches(deps.db, tenantId, userId) }
  },

  get: async (tenantId: string | undefined, batchId: string, reply: FastifyReply) => {
    if (tenantId === undefined) throw new Error('tenant context missing')
    const result = await getBatch(deps.db, tenantId, batchId)
    if (result === null) {
      return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound('batch'))
    }
    return reply.send({
      batch_id: result.batch.batchId,
      status: result.batch.status,
      total_items: result.batch.totalItems,
      items: result.items.map((item) => ({
        position: item.position,
        doc_type: item.docType,
        status: item.status,
        validation_id: item.validationId,
        error_code: item.errorCode,
        verdict: item.verdict,
        confidence: item.confidence,
        explanation: item.explanation,
      })),
    })
  },

  export: async (
    tenantId: string | undefined,
    batchId: string,
    format: 'csv' | 'json',
    reply: FastifyReply,
  ) => {
    if (tenantId === undefined) throw new Error('tenant context missing')
    const items = await getBatchExport(deps.db, tenantId, batchId)
    if (items === null) {
      return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound('batch'))
    }

    if (format === 'json') {
      reply.header('content-type', 'application/json')
      reply.header('content-disposition', `attachment; filename="batch-${batchId}.json"`)
      return reply.send(
        JSON.stringify(
          items.map((item) => ({
            position: item.position,
            document_type: item.docType,
            document: item.docDigits,
            status: item.status,
            verdict: item.verdict,
            confidence: item.confidence,
            explanation: item.explanation,
            error_code: item.errorCode,
          })),
          null,
          2,
        ),
      )
    }

    const header = 'posicao,tipo_documento,documento,status,veredito,confianca,explicacao,erro'
    const lines = items.map((item) => {
      const confidence = item.confidence !== null ? (item.confidence * 100).toFixed(0) + '%' : ''
      const explanation = (item.explanation ?? '').replace(/"/g, '""').replace(/\n/g, ' ')
      const error = item.errorCode ?? ''
      return `${item.position},${item.docType},${item.docDigits},${item.status},${item.verdict ?? ''},${confidence},"${explanation}",${error}`
    })
    reply.header('content-type', 'text/csv; charset=utf-8')
    reply.header('content-disposition', `attachment; filename="batch-${batchId}.csv"`)
    return reply.send([header, ...lines].join('\n'))
  },
})
