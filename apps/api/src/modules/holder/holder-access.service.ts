import { and, eq, inArray, isNotNull, isNull, sql, withTenant } from '@comprova/db'
import type { Db, DbTx } from '@comprova/db'
import * as t from '@comprova/db'
import type {
  HolderAccessItem,
  HolderAccessRequest,
  HolderInformationRequestItem,
  HolderInformationRequestState,
} from '@comprova/contracts'
import type { Logger, Metrics } from '@comprova/observability'
import { sha256Of } from '@comprova/providers'
import type { ObjectStore } from '@comprova/providers'
import { randomUUID } from 'node:crypto'
import {
  expireIfNeeded,
  findRequestById,
  insertHolderInformationRequestEvent,
  lockRequestById,
  type HolderInformationRequestRow,
} from './holder-information-request.shared.js'
import { hashHolderAccessToken, holderTokenPrefixOf } from './holder-token.js'
import { validateDocumentContent, type DocumentContentError } from '../../services/document-content.js'

const errorNameOf = (error: unknown): string => (error instanceof Error ? error.name : 'unknown')

/** Tipo de contexto resolvido a partir do token (sem tenant no chamador). */
export interface HolderTokenContext {
  readonly tokenId: string
  readonly tenantId: string
  readonly holderId: string
  readonly requestId: string
  readonly firstAccessedAt: Date | null
}

export interface ResolvedHolderTokenRow {
  readonly token_id: string
  readonly tenant_id: string
  readonly holder_id: string
  readonly holder_information_request_id: string
  readonly first_accessed_at: Date | null
}

export type HolderAccessResult =
  | { readonly kind: 'ok'; readonly view: HolderAccessRequest }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'invalid_state'; readonly state: HolderInformationRequestState }
  | { readonly kind: 'item_not_found'; readonly itemId: string }
  | { readonly kind: 'invalid_item'; readonly itemId: string; readonly reason: string }
  | {
      readonly kind: 'missing_items'
      readonly missing: readonly { readonly itemId: string; readonly description: string }[]
    }
  | { readonly kind: 'document_not_found' }
  | { readonly kind: 'storage_unavailable' }
  | { readonly kind: 'audit_unavailable' }

export type HolderDeleteDocumentResult = HolderAccessResult | { readonly kind: 'deleted' }

export interface HolderAccessDeps {
  readonly db: Db
  readonly store: ObjectStore
  readonly pepper: string
  readonly logger: Logger
  readonly metrics?: Metrics
  readonly maxDocumentBytes: number
}

const MUTABLE_STATES: ReadonlySet<HolderInformationRequestState> = new Set(['pending', 'in_progress'])
const READABLE_STATES: ReadonlySet<HolderInformationRequestState> = new Set([
  'pending',
  'in_progress',
  'completed',
])

const isMutable = (state: HolderInformationRequestState): boolean => MUTABLE_STATES.has(state)

export const holderDocumentStorageKey = (tenantId: string, requestId: string, documentId: string): string =>
  `tenants/${tenantId}/holder-requests/${requestId}/${documentId}`

const parseItems = (items: unknown): HolderInformationRequestItem[] => {
  if (!Array.isArray(items)) return []
  return items.filter(
    (item): item is HolderInformationRequestItem =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { itemId?: unknown }).itemId === 'string' &&
      typeof (item as { description?: unknown }).description === 'string' &&
      typeof (item as { required?: unknown }).required === 'boolean',
  )
}

interface Authorized {
  readonly kind: 'ok'
  readonly request: HolderInformationRequestRow
  readonly state: HolderInformationRequestState
  readonly firstAccessClaimed: boolean
}

type AuthorizeOutcome =
  Authorized | { readonly kind: 'not_found' } | { readonly kind: 'expired' } | { readonly kind: 'cancelled' }

/**
 * Autoriza o token dentro de uma transação já com o tenant configurado.
 *
 * Pré-condição: o contexto veio do resolver SECURITY DEFINER. Aqui reforçamos
 * a associação token ↔ solicitação ↔ tenant ↔ Holder, sempre com o lock da
 * solicitação antes do token. Solicitações `completed` continuam legíveis; as
 * mutações é que exigem estado pendente/em andamento.
 */
const authorizeInTx = async (
  tx: DbTx,
  context: HolderTokenContext,
  actor: string,
): Promise<AuthorizeOutcome> => {
  const locked = await lockRequestById(tx, context.tenantId, context.requestId)
  if (!locked) return { kind: 'not_found' }
  if (locked.holderId !== context.holderId) return { kind: 'not_found' }

  const expiring = await expireIfNeeded(tx, context.tenantId, context.requestId, actor)
  if (expiring === null) return { kind: 'not_found' }

  const request = await findRequestById(tx, context.tenantId, context.requestId)
  if (!request) return { kind: 'not_found' }

  const state = request.state as HolderInformationRequestState

  // O token precisa continuar existindo, pertencer a esta solicitação/tenant/
  // Holder e não ter sido revogado nem expirado entre a resolução e o lock.
  const [token] = await tx
    .select()
    .from(t.holderAccessToken)
    .where(
      and(
        eq(t.holderAccessToken.tokenId, context.tokenId),
        eq(t.holderAccessToken.tenantId, context.tenantId),
        eq(t.holderAccessToken.holderInformationRequestId, context.requestId),
        eq(t.holderAccessToken.holderId, context.holderId),
        isNull(t.holderAccessToken.revokedAt),
        sql`${t.holderAccessToken.expiresAt} > clock_timestamp()`,
      ),
    )
    .limit(1)
    .for('update')

  if (!token) return { kind: 'not_found' }

  if (state === 'expired') return { kind: 'expired' }
  if (state === 'cancelled') return { kind: 'cancelled' }

  let firstAccessClaimed = false
  if (token.firstAccessedAt === null && READABLE_STATES.has(state)) {
    // Condicional: mesmo que outra requisição concorrente já tenha marcado, não
    // reescrevemos e não duplicamos o evento `holder_accessed`.
    const claimed = await tx
      .update(t.holderAccessToken)
      .set({ firstAccessedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(t.holderAccessToken.tokenId, context.tokenId),
          isNull(t.holderAccessToken.firstAccessedAt),
          isNull(t.holderAccessToken.revokedAt),
          sql`${t.holderAccessToken.expiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ tokenId: t.holderAccessToken.tokenId })

    if (claimed.length > 0) {
      firstAccessClaimed = true
      await insertHolderInformationRequestEvent(tx, context.tenantId, {
        holderInformationRequestId: context.requestId,
        eventType: 'holder_accessed',
        fromState: state,
        toState: state,
        actor,
        details: JSON.stringify({ tokenId: context.tokenId }),
      })
    }
  }

  return { kind: 'ok', request, state, firstAccessClaimed }
}

const loadView = async (
  tx: DbTx,
  tenantId: string,
  request: HolderInformationRequestRow,
  state: HolderInformationRequestState,
): Promise<HolderAccessRequest> => {
  const responses = await tx
    .select({
      itemId: t.holderItemResponse.itemId,
      value: t.holderItemResponse.value,
    })
    .from(t.holderItemResponse)
    .where(
      and(
        eq(t.holderItemResponse.tenantId, tenantId),
        eq(t.holderItemResponse.holderInformationRequestId, request.id),
      ),
    )

  const documents = await tx
    .select({
      documentId: t.holderInformationRequestDocument.documentId,
      itemId: t.holderInformationRequestDocument.itemId,
      contentType: t.holderInformationRequestDocument.contentType,
      sizeBytes: t.holderInformationRequestDocument.sizeBytes,
      originalFilename: t.holderInformationRequestDocument.originalFilename,
      createdAt: t.holderInformationRequestDocument.createdAt,
    })
    .from(t.holderInformationRequestDocument)
    .where(
      and(
        eq(t.holderInformationRequestDocument.tenantId, tenantId),
        eq(t.holderInformationRequestDocument.holderInformationRequestId, request.id),
        eq(t.holderInformationRequestDocument.uploadState, 'stored'),
        isNull(t.holderInformationRequestDocument.deletedAt),
      ),
    )
    .orderBy(t.holderInformationRequestDocument.createdAt)

  const valueByItem = new Map(responses.map((row) => [row.itemId, row.value]))
  const documentsByItem = new Map<string, HolderAccessItem['documents']>()
  for (const document of documents) {
    const list = documentsByItem.get(document.itemId) ?? []
    list.push({
      documentId: document.documentId,
      contentType: document.contentType ?? 'application/octet-stream',
      sizeBytes: Number(document.sizeBytes ?? 0),
      originalFilename: document.originalFilename ?? '',
      createdAt: document.createdAt.toISOString(),
    })
    documentsByItem.set(document.itemId, list)
  }

  const items: HolderAccessItem[] = parseItems(request.items).map((item) => ({
    itemId: item.itemId,
    description: item.description,
    required: item.required,
    ...(item.documentType !== undefined ? { documentType: item.documentType } : {}),
    value: valueByItem.get(item.itemId) ?? null,
    documents: documentsByItem.get(item.itemId) ?? [],
  }))

  return {
    requestId: request.id,
    type: request.type,
    purpose: request.purpose,
    state,
    expiresAt: request.expiresAt?.toISOString() ?? null,
    completedAt: request.completedAt?.toISOString() ?? null,
    items,
  }
}

const toViewResult = async (
  tx: DbTx,
  context: HolderTokenContext,
  authorized: Authorized,
): Promise<HolderAccessResult> => ({
  kind: 'ok',
  view: await loadView(tx, context.tenantId, authorized.request, authorized.state),
})

const mapAuthorize = (outcome: AuthorizeOutcome): HolderAccessResult | null => {
  switch (outcome.kind) {
    case 'ok':
      return null
    case 'not_found':
      return { kind: 'not_found' }
    case 'expired':
      return { kind: 'expired' }
    case 'cancelled':
      return { kind: 'cancelled' }
  }
}

const findItem = (
  request: HolderInformationRequestRow,
  itemId: string,
): HolderInformationRequestItem | undefined =>
  parseItems(request.items).find((item) => item.itemId === itemId)

/**
 * Serviço de acesso do Holder sem conta.
 *
 * A resolução do token acontece fora de `withTenant`, porque o tenant só é
 * conhecido depois que o hash confere. Toda operação seguinte abre uma
 * transação tenant-scoped e revalida a associação antes de ler ou escrever.
 */
export const makeHolderAccessService = (deps: HolderAccessDeps) => {
  const { db, store, pepper, logger, metrics } = deps

  const logError = (operation: string, tenantId: string | null, error: unknown): void => {
    logger.error(
      {
        ...(tenantId !== null ? { tenant_id: tenantId } : {}),
        operation,
        error_name: errorNameOf(error),
      },
      'holder access operation failed',
    )
  }

  /** Resolve o token pelo prefixo + HMAC usando a função SECURITY DEFINER. */
  const resolveToken = async (token: string): Promise<HolderTokenContext | null> => {
    const prefix = holderTokenPrefixOf(token)
    const hash = hashHolderAccessToken(token, pepper)
    const rows = (await db.execute(sql`
      SELECT token_id, tenant_id, holder_id, holder_information_request_id, first_accessed_at
        FROM public.app_resolve_holder_access_token(${prefix}, ${hash})
    `)) as unknown as readonly ResolvedHolderTokenRow[]
    const row = rows[0]
    if (!row) return null
    return {
      tokenId: row.token_id,
      tenantId: row.tenant_id,
      holderId: row.holder_id,
      requestId: row.holder_information_request_id,
      firstAccessedAt: row.first_accessed_at,
    }
  }

  const getView = async (context: HolderTokenContext, actor: string): Promise<HolderAccessResult> =>
    withTenant(db, context.tenantId, async (tx) => {
      const authorized = await authorizeInTx(tx, context, actor)
      if (authorized.kind !== 'ok') {
        return mapAuthorize(authorized) as HolderAccessResult
      }
      return toViewResult(tx, context, authorized)
    })

  const saveItem = async (
    context: HolderTokenContext,
    actor: string,
    itemId: string,
    rawValue: string,
  ): Promise<HolderAccessResult> => {
    const value = rawValue.trim()
    if (value.length < 1 || value.length > 5000) {
      return { kind: 'invalid_item', itemId, reason: 'value_length' }
    }

    return withTenant(db, context.tenantId, async (tx) => {
      const authorized = await authorizeInTx(tx, context, actor)
      if (authorized.kind !== 'ok') {
        return mapAuthorize(authorized) as HolderAccessResult
      }
      if (!isMutable(authorized.state)) {
        return { kind: 'invalid_state', state: authorized.state }
      }

      const item = findItem(authorized.request, itemId)
      if (!item) return { kind: 'item_not_found', itemId }

      await tx
        .insert(t.holderItemResponse)
        .values({
          responseId: randomUUID(),
          tenantId: context.tenantId,
          holderInformationRequestId: context.requestId,
          itemId,
          value,
          createdBy: actor,
        })
        .onConflictDoUpdate({
          target: [t.holderItemResponse.holderInformationRequestId, t.holderItemResponse.itemId],
          set: {
            value,
            createdBy: actor,
            updatedAt: sql`clock_timestamp()`,
          },
        })

      await insertHolderInformationRequestEvent(tx, context.tenantId, {
        holderInformationRequestId: context.requestId,
        eventType: 'holder_response_saved',
        fromState: authorized.state,
        toState: authorized.state,
        actor,
        details: JSON.stringify({ itemId }),
      })

      return toViewResult(tx, context, authorized)
    })
  }

  const uploadDocument = async (
    context: HolderTokenContext,
    actor: string,
    itemId: string,
    data: Uint8Array,
    declaredContentType: string | undefined,
    originalFilename: string,
  ): Promise<HolderAccessResult> => {
    let contentType: string
    try {
      contentType = validateDocumentContent(data, declaredContentType, deps.maxDocumentBytes)
    } catch (error) {
      const code = (error as DocumentContentError).code
      logError('upload_validate', context.tenantId, error)
      return { kind: 'invalid_item', itemId, reason: code ?? 'invalid_content' }
    }

    const documentId = randomUUID()
    const storageKey = holderDocumentStorageKey(context.tenantId, context.requestId, documentId)
    const sha256 = sha256Of(data)

    const intent = await withTenant(db, context.tenantId, async (tx) => {
      const authorized = await authorizeInTx(tx, context, actor)
      if (authorized.kind !== 'ok') {
        return mapAuthorize(authorized) as HolderAccessResult
      }
      if (!isMutable(authorized.state)) {
        return { kind: 'invalid_state', state: authorized.state } as HolderAccessResult
      }

      const item = findItem(authorized.request, itemId)
      if (!item) return { kind: 'item_not_found', itemId } as HolderAccessResult
      if (item.documentType === undefined || item.documentType.trim() === '') {
        return {
          kind: 'invalid_item',
          itemId,
          reason: 'item_without_document_type',
        } as HolderAccessResult
      }

      // Intenção durável: a linha `pending` é commitada ANTES do storage.
      await tx.insert(t.holderInformationRequestDocument).values({
        documentId,
        tenantId: context.tenantId,
        holderInformationRequestId: context.requestId,
        itemId,
        uploadState: 'pending',
        storageKey,
      })

      return null
    })

    if (intent !== null) return intent

    metrics?.holderDocumentUploads.inc({ outcome: 'started' })

    try {
      const stored = await store.put(storageKey, data, contentType)
      if (stored.bytes !== data.byteLength || !stored.sha256.equals(sha256)) {
        throw new Error('object storage returned inconsistent metadata')
      }
    } catch (error) {
      metrics?.holderDocumentUploads.inc({ outcome: 'failed' })
      // O put pode ter falhado antes ou depois de gravar; tenta remover o
      // objeto e a intenção com o mesmo critério do finalize.
      await compensateUpload(context.tenantId, documentId, storageKey, {
        objectStored: true,
        trigger: 'put_failed',
      })
      logError('upload_put', context.tenantId, error)
      return { kind: 'storage_unavailable' }
    }

    try {
      const finalize = await withTenant(db, context.tenantId, async (tx) => {
        const authorized = await authorizeInTx(tx, context, actor)
        if (authorized.kind !== 'ok') {
          return { kind: 'auth', outcome: authorized } as const
        }
        if (!isMutable(authorized.state)) {
          return { kind: 'not_mutable', state: authorized.state } as const
        }

        const [finalized] = await tx
          .update(t.holderInformationRequestDocument)
          .set({
            uploadState: 'stored',
            contentType,
            sizeBytes: data.byteLength,
            sha256,
            originalFilename,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(t.holderInformationRequestDocument.documentId, documentId),
              eq(t.holderInformationRequestDocument.tenantId, context.tenantId),
              eq(t.holderInformationRequestDocument.uploadState, 'pending'),
              isNull(t.holderInformationRequestDocument.deletedAt),
            ),
          )
          .returning({ documentId: t.holderInformationRequestDocument.documentId })

        if (!finalized) {
          return { kind: 'intent_missing' } as const
        }

        await insertHolderInformationRequestEvent(tx, context.tenantId, {
          holderInformationRequestId: context.requestId,
          eventType: 'holder_document_uploaded',
          fromState: authorized.state,
          toState: authorized.state,
          actor,
          details: JSON.stringify({
            documentId,
            itemId,
            contentType,
            sizeBytes: data.byteLength,
          }),
        })

        metrics?.holderDocumentUploads.inc({ outcome: 'stored' })
        return {
          kind: 'done',
          result: await toViewResult(tx, context, authorized),
        } as const
      })

      if (finalize.kind !== 'done') {
        // A solicitação deixou de aceitar uploads (ou a intenção sumiu) entre o
        // commit da intenção e o finalize: o objeto não pode permanecer.
        await compensateUpload(context.tenantId, documentId, storageKey, {
          objectStored: true,
          trigger: 'finalize_state_changed',
        })

        if (finalize.kind === 'auth') {
          return mapAuthorize(finalize.outcome) as HolderAccessResult
        }
        if (finalize.kind === 'intent_missing') {
          return { kind: 'invalid_item', itemId, reason: 'upload_intent_missing' }
        }
        return { kind: 'invalid_state', state: finalize.state }
      }

      return finalize.result
    } catch (error) {
      metrics?.holderDocumentUploads.inc({ outcome: 'failed' })
      await compensateUpload(context.tenantId, documentId, storageKey, {
        objectStored: true,
        trigger: 'finalize_failed',
      })
      logError('upload_finalize', context.tenantId, error)
      return { kind: 'storage_unavailable' }
    }
  }

  /**
   * Compensação do upload: remove o objeto (idempotente) e, só quando o objeto
   * está confirmadamente fora do storage, remove a intenção `pending`. Se o
   * delete do objeto falha, a intenção permanece para reconciliação manual —
   * não há cleanup automático nesta entrega.
   */
  const compensateUpload = async (
    tenantId: string,
    documentId: string,
    storageKey: string,
    options: { readonly objectStored: boolean; readonly trigger: string },
  ): Promise<void> => {
    let objectRemoved = !options.objectStored
    if (options.objectStored) {
      try {
        await store.delete(storageKey)
        objectRemoved = true
      } catch (error) {
        logger.warn(
          {
            tenant_id: tenantId,
            operation: 'holder_document_compensation',
            trigger: options.trigger,
            error_name: errorNameOf(error),
          },
          'holder document object compensation failed',
        )
      }
    }
    if (!objectRemoved) return

    try {
      await withTenant(db, tenantId, async (tx) => {
        await tx
          .delete(t.holderInformationRequestDocument)
          .where(
            and(
              eq(t.holderInformationRequestDocument.documentId, documentId),
              eq(t.holderInformationRequestDocument.tenantId, tenantId),
              eq(t.holderInformationRequestDocument.uploadState, 'pending'),
            ),
          )
      })
    } catch (error) {
      logger.warn(
        {
          tenant_id: tenantId,
          operation: 'holder_document_compensation',
          trigger: options.trigger,
          error_name: errorNameOf(error),
        },
        'holder document pending intent compensation failed',
      )
    }
  }

  const deleteDocument = async (
    context: HolderTokenContext,
    actor: string,
    itemId: string,
    documentId: string,
  ): Promise<HolderDeleteDocumentResult> => {
    // 1. Verifica tombstone primeiro, antes de exigir autorização completa.
    //    Isso permite recuperar a finalização mesmo quando o token expirou ou
    //    a solicitação já não é mutável (completed/expired/cancelled) — o
    //    contexto do token (resolvido por resolveToken) já garante
    //    tenant/request/holder.
    const tombstoneResult = await withTenant(db, context.tenantId, async (tx) => {
      const [existing] = await tx
        .select({
          storageKey: t.holderInformationRequestDocument.storageKey,
          deletedAt: t.holderInformationRequestDocument.deletedAt,
        })
        .from(t.holderInformationRequestDocument)
        .where(
          and(
            eq(t.holderInformationRequestDocument.documentId, documentId),
            eq(t.holderInformationRequestDocument.tenantId, context.tenantId),
            eq(t.holderInformationRequestDocument.holderInformationRequestId, context.requestId),
            eq(t.holderInformationRequestDocument.itemId, itemId),
          ),
        )
        .limit(1)

      if (!existing) {
        return { kind: 'not_tombstoned' } as const
      }

      if (existing.deletedAt === null) {
        return { kind: 'not_tombstoned' } as const
      }

      // Já tombstoned: busca o estado da solicitação para o evento de auditoria.
      const [requestRow] = await tx
        .select({ state: t.holderInformationRequest.state })
        .from(t.holderInformationRequest)
        .where(
          and(
            eq(t.holderInformationRequest.id, context.requestId),
            eq(t.holderInformationRequest.tenantId, context.tenantId),
          ),
        )
        .limit(1)

      return {
        kind: 'tombstoned',
        storageKey: existing.storageKey,
        state: requestRow?.state ?? null,
      } as const
    })

    if (tombstoneResult.kind === 'tombstoned') {
      const { storageKey, state } = tombstoneResult

      // Fast path: já concluído por uma chamada anterior (evento de remoção
      // existe). Verifica com itemId para evitar falso positivo (#2).
      const [alreadyRemoved] = await withTenant(db, context.tenantId, async (tx) =>
        tx
          .select({ id: t.holderInformationRequestEvent.id })
          .from(t.holderInformationRequestEvent)
          .where(
            and(
              eq(t.holderInformationRequestEvent.tenantId, context.tenantId),
              eq(t.holderInformationRequestEvent.holderInformationRequestId, context.requestId),
              eq(t.holderInformationRequestEvent.eventType, 'holder_document_removed'),
              sql`${t.holderInformationRequestEvent.details}::jsonb ->> 'documentId' = ${documentId}`,
              sql`${t.holderInformationRequestEvent.details}::jsonb ->> 'itemId' = ${itemId}`,
            ),
          )
          .limit(1),
      )

      if (alreadyRemoved) return { kind: 'deleted' }

      // Prossegue para remoção física + finalização.
      const finalState = (state ?? 'in_progress') as HolderInformationRequestState

      // Tombstone já commitado; só agora removemos o objeto físico.
      try {
        await store.delete(storageKey)
      } catch (error) {
        metrics?.holderDocumentUploads.inc({ outcome: 'failed' })
        logError('document_delete', context.tenantId, error)
        return { kind: 'storage_unavailable' }
      }

      metrics?.holderDocumentUploads.inc({ outcome: 'deleted' })

      try {
        await withTenant(db, context.tenantId, async (tx) => {
          await tx
            .select({ documentId: t.holderInformationRequestDocument.documentId })
            .from(t.holderInformationRequestDocument)
            .where(
              and(
                eq(t.holderInformationRequestDocument.documentId, documentId),
                eq(t.holderInformationRequestDocument.tenantId, context.tenantId),
                eq(t.holderInformationRequestDocument.holderInformationRequestId, context.requestId),
                isNotNull(t.holderInformationRequestDocument.deletedAt),
              ),
            )
            .limit(1)
            .for('update')

          const [alreadyRemoved] = await tx
            .select({ id: t.holderInformationRequestEvent.id })
            .from(t.holderInformationRequestEvent)
            .where(
              and(
                eq(t.holderInformationRequestEvent.tenantId, context.tenantId),
                eq(t.holderInformationRequestEvent.holderInformationRequestId, context.requestId),
                eq(t.holderInformationRequestEvent.eventType, 'holder_document_removed'),
                sql`${t.holderInformationRequestEvent.details}::jsonb ->> 'documentId' = ${documentId}`,
                sql`${t.holderInformationRequestEvent.details}::jsonb ->> 'itemId' = ${itemId}`,
              ),
            )
            .limit(1)

          if (alreadyRemoved) return

          await tx
            .delete(t.holderInformationRequestDocument)
            .where(
              and(
                eq(t.holderInformationRequestDocument.documentId, documentId),
                eq(t.holderInformationRequestDocument.tenantId, context.tenantId),
                eq(t.holderInformationRequestDocument.holderInformationRequestId, context.requestId),
              ),
            )

          await insertHolderInformationRequestEvent(tx, context.tenantId, {
            holderInformationRequestId: context.requestId,
            eventType: 'holder_document_removed',
            fromState: finalState,
            toState: finalState,
            actor,
            details: JSON.stringify({ documentId, itemId }),
          })
        })
      } catch (error) {
        logError('document_delete_finalize', context.tenantId, error)
        return { kind: 'audit_unavailable' }
      }

      return { kind: 'deleted' }
    }

    // 2. Documento não está tombstoned: fluxo normal com autorização completa.
    const authorizedResult = await withTenant(db, context.tenantId, async (tx) => {
      const authorized = await authorizeInTx(tx, context, actor)
      if (authorized.kind !== 'ok') {
        return { kind: 'auth', result: mapAuthorize(authorized) as HolderAccessResult } as const
      }

      const item = findItem(authorized.request, itemId)
      if (!item) {
        return { kind: 'auth', result: { kind: 'item_not_found', itemId } } as const
      }

      // Estado não mutável (completed/expired/cancelled) sem tombstone: 409.
      if (!isMutable(authorized.state)) {
        return {
          kind: 'auth',
          result: { kind: 'invalid_state', state: authorized.state },
        } as const
      }
      // Fast path: já concluído por uma chamada anterior.
      const [alreadyRemoved] = await tx
        .select({ id: t.holderInformationRequestEvent.id })
        .from(t.holderInformationRequestEvent)
        .where(
          and(
            eq(t.holderInformationRequestEvent.tenantId, context.tenantId),
            eq(t.holderInformationRequestEvent.holderInformationRequestId, context.requestId),
            eq(t.holderInformationRequestEvent.eventType, 'holder_document_removed'),
            sql`${t.holderInformationRequestEvent.details}::jsonb ->> 'documentId' = ${documentId}`,
            sql`${t.holderInformationRequestEvent.details}::jsonb ->> 'itemId' = ${itemId}`,
          ),
        )
        .limit(1)

      if (alreadyRemoved) return { kind: 'deleted' }

      // Tenta persistir o tombstone na linha ainda não deletada.
      const [marked] = await tx
        .update(t.holderInformationRequestDocument)
        .set({ deletedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(t.holderInformationRequestDocument.documentId, documentId),
            eq(t.holderInformationRequestDocument.tenantId, context.tenantId),
            eq(t.holderInformationRequestDocument.holderInformationRequestId, context.requestId),
            eq(t.holderInformationRequestDocument.itemId, itemId),
            isNull(t.holderInformationRequestDocument.deletedAt),
          ),
        )
        .returning({ storageKey: t.holderInformationRequestDocument.storageKey })

      if (marked) {
        await insertHolderInformationRequestEvent(tx, context.tenantId, {
          holderInformationRequestId: context.requestId,
          eventType: 'holder_document_removal_requested',
          fromState: authorized.state,
          toState: authorized.state,
          actor,
          details: JSON.stringify({ documentId, itemId }),
        })

        return {
          kind: 'tombstoned',
          storageKey: marked.storageKey,
          state: authorized.state,
        } as const
      }

      // Linha já tombstoned por outra chamada. Verifica se a finalização
      // já foi completada concorrentemente antes de declarar 404 (#7).
      const [existing] = await tx
        .select({ storageKey: t.holderInformationRequestDocument.storageKey })
        .from(t.holderInformationRequestDocument)
        .where(
          and(
            eq(t.holderInformationRequestDocument.documentId, documentId),
            eq(t.holderInformationRequestDocument.tenantId, context.tenantId),
            eq(t.holderInformationRequestDocument.holderInformationRequestId, context.requestId),
            eq(t.holderInformationRequestDocument.itemId, itemId),
          ),
        )
        .limit(1)

      if (!existing) {
        const [alreadyRemovedAfter] = await tx
          .select({ id: t.holderInformationRequestEvent.id })
          .from(t.holderInformationRequestEvent)
          .where(
            and(
              eq(t.holderInformationRequestEvent.tenantId, context.tenantId),
              eq(t.holderInformationRequestEvent.holderInformationRequestId, context.requestId),
              eq(t.holderInformationRequestEvent.eventType, 'holder_document_removed'),
              sql`${t.holderInformationRequestEvent.details}::jsonb ->> 'documentId' = ${documentId}`,
              sql`${t.holderInformationRequestEvent.details}::jsonb ->> 'itemId' = ${itemId}`,
            ),
          )
          .limit(1)

        if (alreadyRemovedAfter) return { kind: 'deleted' }

        return { kind: 'auth', result: { kind: 'document_not_found' } } as const
      }

      // Já tombstoned: não repete `holder_document_removal_requested`, mas
      // devolve a storage key para que a remoção física seja tentada de novo
      // (a chamada anterior pode ter falhado no object storage).
      return {
        kind: 'tombstoned',
        storageKey: existing.storageKey,
        state: authorized.state,
      } as const
    })

    if (authorizedResult.kind === 'deleted') return { kind: 'deleted' }
    if (authorizedResult.kind !== 'tombstoned') {
      return authorizedResult.result as HolderAccessResult
    }

    const tombstoned = authorizedResult as {
      readonly kind: 'tombstoned'
      readonly storageKey: string
      readonly state: HolderInformationRequestState
    }
    const { storageKey, state } = tombstoned

    // Tombstone já commitado; só agora removemos o objeto físico. A remoção é
    // idempotente, então toda chamada DELETE repete a tentativa.
    try {
      await store.delete(storageKey)
    } catch (error) {
      metrics?.holderDocumentUploads.inc({ outcome: 'failed' })
      logError('document_delete', context.tenantId, error)
      // O tombstone (e a storage key) permanece commitado: uma nova chamada
      // reattempta a remoção física. Nunca respondemos sucesso enquanto o
      // objeto ainda pode existir no storage.
      return { kind: 'storage_unavailable' }
    }

    metrics?.holderDocumentUploads.inc({ outcome: 'deleted' })

    try {
      await withTenant(db, context.tenantId, async (tx) => {
        // Serializa finalizações concorrentes na mesma linha tombstoned: o
        // evento `holder_document_removed` é inserido no máximo uma vez.
        await tx
          .select({ documentId: t.holderInformationRequestDocument.documentId })
          .from(t.holderInformationRequestDocument)
          .where(
            and(
              eq(t.holderInformationRequestDocument.documentId, documentId),
              eq(t.holderInformationRequestDocument.tenantId, context.tenantId),
              eq(t.holderInformationRequestDocument.holderInformationRequestId, context.requestId),
              isNotNull(t.holderInformationRequestDocument.deletedAt),
            ),
          )
          .limit(1)
          .for('update')

        const [alreadyRemoved] = await tx
          .select({ id: t.holderInformationRequestEvent.id })
          .from(t.holderInformationRequestEvent)
          .where(
            and(
              eq(t.holderInformationRequestEvent.tenantId, context.tenantId),
              eq(t.holderInformationRequestEvent.holderInformationRequestId, context.requestId),
              eq(t.holderInformationRequestEvent.eventType, 'holder_document_removed'),
              sql`${t.holderInformationRequestEvent.details}::jsonb ->> 'documentId' = ${documentId}`,
              sql`${t.holderInformationRequestEvent.details}::jsonb ->> 'itemId' = ${itemId}`,
            ),
          )
          .limit(1)

        if (alreadyRemoved) return

        // Remove os metadados somente após a exclusão física confirmada. A
        // auditoria `holder_document_removed` fica na tabela de eventos e
        // sobrevive à remoção desta linha, portanto a dedupe não depende
        // da existência do documento.
        await tx
          .delete(t.holderInformationRequestDocument)
          .where(
            and(
              eq(t.holderInformationRequestDocument.documentId, documentId),
              eq(t.holderInformationRequestDocument.tenantId, context.tenantId),
              eq(t.holderInformationRequestDocument.holderInformationRequestId, context.requestId),
            ),
          )

        await insertHolderInformationRequestEvent(tx, context.tenantId, {
          holderInformationRequestId: context.requestId,
          eventType: 'holder_document_removed',
          fromState: state,
          toState: state,
          actor,
          details: JSON.stringify({ documentId, itemId }),
        })
      })
    } catch (error) {
      logError('document_delete_finalize', context.tenantId, error)
      // A exclusão física já foi confirmada, mas a finalização (remoção dos
      // metadados + gravação da auditoria) não foi persistida. O tombstone e
      // os metadados permanecem para que uma nova chamada DELETE conclua a
      // operação. Não é erro de storage.
      return { kind: 'audit_unavailable' }
    }

    return { kind: 'deleted' }
  }

  const submit = async (context: HolderTokenContext, actor: string): Promise<HolderAccessResult> =>
    withTenant(db, context.tenantId, async (tx) => {
      const authorized = await authorizeInTx(tx, context, actor)
      if (authorized.kind !== 'ok') {
        return mapAuthorize(authorized) as HolderAccessResult
      }

      if (authorized.state === 'completed') {
        // Idempotente: um novo submit não cria um segundo evento terminal.
        return toViewResult(tx, context, authorized)
      }
      if (!isMutable(authorized.state)) {
        return { kind: 'invalid_state', state: authorized.state }
      }

      const items = parseItems(authorized.request.items)
      const required = items.filter((item) => item.required)

      const responses = await tx
        .select({ itemId: t.holderItemResponse.itemId, value: t.holderItemResponse.value })
        .from(t.holderItemResponse)
        .where(
          and(
            eq(t.holderItemResponse.tenantId, context.tenantId),
            eq(t.holderItemResponse.holderInformationRequestId, context.requestId),
          ),
        )
      const valueByItem = new Map(responses.map((row) => [row.itemId, row.value]))

      const requiredWithDocuments = required
        .filter((item) => item.documentType !== undefined && item.documentType.trim() !== '')
        .map((item) => item.itemId)

      const storedDocumentItems = new Set<string>()
      if (requiredWithDocuments.length > 0) {
        const documents = await tx
          .select({ itemId: t.holderInformationRequestDocument.itemId })
          .from(t.holderInformationRequestDocument)
          .where(
            and(
              eq(t.holderInformationRequestDocument.tenantId, context.tenantId),
              eq(t.holderInformationRequestDocument.holderInformationRequestId, context.requestId),
              eq(t.holderInformationRequestDocument.uploadState, 'stored'),
              isNull(t.holderInformationRequestDocument.deletedAt),
              inArray(t.holderInformationRequestDocument.itemId, requiredWithDocuments),
            ),
          )
        for (const document of documents) storedDocumentItems.add(document.itemId)
      }

      const missing = required
        .filter((item) => {
          if (item.documentType !== undefined && item.documentType.trim() !== '') {
            return !storedDocumentItems.has(item.itemId)
          }
          const value = valueByItem.get(item.itemId)
          return value === undefined || value.trim() === ''
        })
        .map((item) => ({ itemId: item.itemId, description: item.description }))

      if (missing.length > 0) {
        return { kind: 'missing_items', missing }
      }

      // Transição atômica: só quem vencer o UPDATE condicional grava o evento
      // terminal. Um submit concorrente vê a solicitação já `completed`.
      const [completed] = await tx
        .update(t.holderInformationRequest)
        .set({
          state: 'completed',
          completedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(t.holderInformationRequest.id, context.requestId),
            eq(t.holderInformationRequest.tenantId, context.tenantId),
            inArray(t.holderInformationRequest.state, ['pending', 'in_progress']),
          ),
        )
        .returning()

      if (!completed) {
        const reloaded = await findRequestById(tx, context.tenantId, context.requestId)
        if (!reloaded) return { kind: 'not_found' }
        const reloadedState = reloaded.state as HolderInformationRequestState
        if (reloadedState === 'completed') {
          return {
            kind: 'ok',
            view: await loadView(tx, context.tenantId, reloaded, reloadedState),
          }
        }
        return { kind: 'invalid_state', state: reloadedState }
      }

      await insertHolderInformationRequestEvent(tx, context.tenantId, {
        holderInformationRequestId: context.requestId,
        eventType: 'completed',
        fromState: authorized.state,
        toState: 'completed',
        actor,
        details: JSON.stringify({ itemCount: items.length }),
      })

      return {
        kind: 'ok',
        view: await loadView(tx, context.tenantId, completed, 'completed'),
      }
    })

  return {
    resolveToken,
    getView,
    saveItem,
    uploadDocument,
    deleteDocument,
    submit,
    logError,
  }
}
