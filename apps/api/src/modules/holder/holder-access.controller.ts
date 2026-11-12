import type { FastifyReply } from 'fastify'
import { PROBLEM_CONTENT_TYPE, problem } from '@comprova/contracts'
import { type HolderAccessResult, type HolderDeleteDocumentResult, makeHolderAccessService } from './holder-access.service.js'
import type { HolderAccessRoutesDeps, HolderProcessingResponseType } from './holder-access.schema.js'

const mapInvalidItem = (
  result: Extract<HolderAccessResult, { kind: 'invalid_item' }>,
  reply: FastifyReply,
) => {
  switch (result.reason) {
    case 'EMPTY':
      return reply
        .code(422)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problem(422, 'EVIDENCE_EMPTY', 'Arquivo vazio'))
    case 'TOO_LARGE':
      return reply
        .code(413)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problem(413, 'EVIDENCE_TOO_LARGE', 'Arquivo excede o limite de upload'))
    case 'UNSUPPORTED':
      return reply
        .code(415)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problem(415, 'UNSUPPORTED_EVIDENCE_TYPE', 'Tipo de arquivo não suportado'))
    case 'CONTENT_MISMATCH':
      return reply
        .code(422)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problem(422, 'EVIDENCE_CONTENT_MISMATCH', 'Conteúdo não corresponde ao tipo declarado'))
    case 'value_length':
      return reply
        .code(422)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problem(422, 'INVALID_RESPONSE', 'A resposta deve ter entre 1 e 5000 caracteres'))
    case 'item_without_document_type':
      return reply
        .code(422)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problem(422, 'ITEM_NOT_DOCUMENT', 'Este item não aceita documentos'))
    case 'upload_intent_missing':
      return reply
        .code(409)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problem(409, 'HOLDER_DOCUMENT_CONFLICT', 'Conflito ao finalizar o upload'))
    default:
      return reply
        .code(422)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problem(422, 'INVALID_DOCUMENT', 'Documento inválido'))
  }
}

export const makeHolderAccessController = (deps: HolderAccessRoutesDeps) => {
  const service = makeHolderAccessService({
    db: deps.db,
    store: deps.store,
    pepper: deps.pepper,
    logger: deps.logger,
    maxDocumentBytes: deps.maxDocumentBytes,
    ...(deps.metrics !== undefined ? { metrics: deps.metrics } : {}),
  })

  const sendResult = (result: HolderAccessResult, reply: FastifyReply): FastifyReply => {
    switch (result.kind) {
      case 'ok':
        return reply.code(200).send(result.view)
      case 'not_found':
        return reply
          .code(401)
          .type(PROBLEM_CONTENT_TYPE)
          .send(problem(401, 'HOLDER_ACCESS_UNAUTHORIZED', 'Token de acesso inválido'))
      case 'expired':
        return reply
          .code(409)
          .type(PROBLEM_CONTENT_TYPE)
          .send(problem(409, 'HOLDER_INFORMATION_REQUEST_EXPIRED', 'Solicitação de informações expirada'))
      case 'cancelled':
        return reply
          .code(409)
          .type(PROBLEM_CONTENT_TYPE)
          .send(problem(409, 'HOLDER_INFORMATION_REQUEST_CANCELLED', 'Solicitação de informações cancelada'))
      case 'invalid_state':
        return reply
          .code(409)
          .type(PROBLEM_CONTENT_TYPE)
          .send(
            problem(
              409,
              'HOLDER_INFORMATION_REQUEST_STATE',
              `Solicitação não aceita esta operação no estado '${result.state}'`,
            ),
          )
      case 'item_not_found':
        return reply
          .code(404)
          .type(PROBLEM_CONTENT_TYPE)
          .send(problem(404, 'HOLDER_ITEM_NOT_FOUND', 'Item não encontrado'))
      case 'invalid_item':
        return mapInvalidItem(result, reply)
      case 'missing_items':
        return reply
          .code(422)
          .type(PROBLEM_CONTENT_TYPE)
          .send(
            problem(
              422,
              'HOLDER_REQUIRED_ITEMS_MISSING',
              'Itens obrigatórios não foram preenchidos',
              result.missing.map((item) => item.itemId).join(','),
            ),
          )
      case 'document_not_found':
        return reply
          .code(404)
          .type(PROBLEM_CONTENT_TYPE)
          .send(problem(404, 'HOLDER_DOCUMENT_NOT_FOUND', 'Documento não encontrado'))
      case 'storage_unavailable':
        return reply
          .code(503)
          .type(PROBLEM_CONTENT_TYPE)
          .send(problem(503, 'EVIDENCE_STORAGE_UNAVAILABLE', 'Armazenamento indisponível'))
      case 'audit_unavailable':
        return reply
          .code(503)
          .type(PROBLEM_CONTENT_TYPE)
          .send(problem(503, 'EVIDENCE_AUDIT_UNAVAILABLE', 'Falha ao persistir auditoria de remoção'))
    }
  }

  return {
    resolveToken: service.resolveToken,

    getView: async (
      context: Parameters<typeof service.getView>[0],
      actor: string,
      reply: FastifyReply,
    ): Promise<FastifyReply> => sendResult(await service.getView(context, actor), reply),

    saveItem: async (
      context: Parameters<typeof service.saveItem>[0],
      actor: string,
      itemId: string,
      value: string,
      reply: FastifyReply,
    ): Promise<FastifyReply> => sendResult(await service.saveItem(context, actor, itemId, value), reply),

    uploadDocument: async (
      context: Parameters<typeof service.uploadDocument>[0],
      actor: string,
      input: {
        readonly itemId: string
        readonly data: Uint8Array
        readonly declaredContentType: string | undefined
        readonly originalFilename: string
      },
      reply: FastifyReply,
    ): Promise<FastifyReply> =>
      sendResult(
        await service.uploadDocument(
          context,
          actor,
          input.itemId,
          input.data,
          input.declaredContentType,
          input.originalFilename,
        ),
        reply,
      ),

    deleteDocument: async (
      context: Parameters<typeof service.deleteDocument>[0],
      actor: string,
      input: { readonly itemId: string; readonly documentId: string },
      reply: FastifyReply,
    ): Promise<FastifyReply> => {
      const result: HolderDeleteDocumentResult = await service.deleteDocument(
        context,
        actor,
        input.itemId,
        input.documentId,
      )
      if (result.kind === 'deleted') return reply.code(204).send()
      // Demais resultados seguem o mesmo mapeamento dos outros endpoints:
      // token inválido → 401, estado incompatível → 409, documento ausente → 404.
      return sendResult(result, reply)
    },

    submit: async (
      context: Parameters<typeof service.submit>[0],
      actor: string,
      reply: FastifyReply,
    ): Promise<FastifyReply> => sendResult(await service.submit(context, actor), reply),

    getProcessing: async (
      context: { readonly tenantId: string },
      requestId: string,
    ): Promise<HolderProcessingResponseType | null> => {
      const processing = await deps.processingService.getProcessing(requestId, context.tenantId)
      if (!processing) return null
      return {
        processingId: processing.processingId,
        holderInformationRequestId: processing.holderInformationRequestId,
        tenantId: processing.tenantId,
        state: processing.state as HolderProcessingResponseType['state'],
        attempts: processing.attempts,
        lastError: processing.lastError,
        createdAt: processing.createdAt.toISOString(),
        updatedAt: processing.updatedAt.toISOString(),
        processedAt: processing.processedAt?.toISOString() ?? null,
      }
    },
  }
}
