import { and, count, eq, isNull, sql, withTenant, type Db } from '@comprova/db'
import * as t from '@comprova/db'
import { randomUUID } from 'node:crypto'
import type { Logger } from '@comprova/observability'
import {
  type HolderInformationRequestDto,
  type HolderInformationRequestState,
  type HolderInformationRequestItem,
  type HolderInformationRequestItems,
} from '@comprova/contracts'
import {
  expireExpiredRequests,
  expireIfNeeded,
  findRequestById,
  insertHolderInformationRequestEvent,
  isExpirableState,
} from './holder-information-request.shared.js'

const errorNameOf = (error: unknown): string => (error instanceof Error ? error.name : 'unknown')

const errorCodeOf = (error: unknown, depth = 0): string | null => {
  if (depth > 3 || typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return code
  return errorCodeOf((error as { cause?: unknown }).cause, depth + 1)
}

export const makeHolderInformationRequestService = (deps: { readonly db: Db; readonly logger: Logger }) => {
  const { db, logger } = deps

  const logServiceError = (operation: string, tenantId: string, error: unknown): void => {
    logger.error(
      {
        tenant_id: tenantId,
        operation,
        error_name: errorNameOf(error),
        error_code: errorCodeOf(error),
      },
      'holder information request operation failed',
    )
  }

  const insertEvent = insertHolderInformationRequestEvent

  const toDto = (row: {
    id: string
    tenantId: string
    holderId: string
    type: string
    purpose: string
    items: unknown
    state: string
    expiresAt: Date | null
    validationId: string | null
    createdBy: string
    createdAt: Date
    updatedAt: Date
    completedAt: Date | null
    cancelledAt: Date | null
    expiredAt: Date | null
  }): HolderInformationRequestDto => ({
    id: row.id,
    tenantId: row.tenantId,
    holderId: row.holderId,
    type: row.type,
    purpose: row.purpose,
    items: (row.items as unknown as HolderInformationRequestItem[]) ?? [],
    state: row.state as unknown as HolderInformationRequestState,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    // PR 1: validation que originou esta solicitação, quando aplicável.
    validationId: row.validationId ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    expiredAt: row.expiredAt?.toISOString() ?? null,
  })

  const createHolderInformationRequest = async (
    actor: string,
    tenantId: string,
    create: {
      readonly type: string
      readonly purpose: string
      readonly items: HolderInformationRequestItems
      readonly expiresAt?: string
      readonly validationId?: string
    },
    holderId: string,
  ): Promise<HolderInformationRequestDto> => {
    // Validar que o holder pertence ao tenant informado (mesma transação).
    const existingHolder = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select({ holderId: t.holder.holderId, tenantId: t.holder.tenantId })
        .from(t.holder)
        .where(and(eq(t.holder.holderId, holderId), eq(t.holder.tenantId, tenantId)))
        .limit(1)
    })

    if (existingHolder.length === 0) {
      throw new Error('holder not found')
    }

    // Validar coerência do prazo: se informado, deve estar no futuro.
    if (create.expiresAt !== undefined && create.expiresAt !== null) {
      const expiresAt = new Date(create.expiresAt)
      if (isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
        throw new Error('prazo inválido: expires_at deve estar no futuro')
      }
    }

    // PR 1: se uma validation for informada, deve pertencer ao mesmo tenant.
    let validationExists = true
    if (create.validationId !== undefined && create.validationId !== null) {
      const validationId = create.validationId
      const [validationRow] = await withTenant(db, tenantId, async (tx) => {
        return tx
          .select({ validationId: t.validation.validationId })
          .from(t.validation)
          .where(and(eq(t.validation.validationId, validationId), eq(t.validation.tenantId, tenantId)))
          .limit(1)
      })
      validationExists = validationRow !== undefined
    }

    if (!validationExists) {
      throw new Error('validation not found')
    }

    const requestId = randomUUID()
    const createdAt = new Date()

    const [inserted] = await withTenant(db, tenantId, async (tx) => {
      const [row] = await tx
        .insert(t.holderInformationRequest)
        .values({
          id: requestId,
          tenantId,
          holderId,
          type: create.type,
          purpose: create.purpose,
          items: create.items,
          state: 'pending' as HolderInformationRequestState,
          expiresAt: create.expiresAt ? new Date(create.expiresAt) : null,
          // PR 1: vinculação opcional à validation do Verifier.
          validationId: create.validationId ?? null,
          createdBy: actor,
          createdAt,
          updatedAt: createdAt,
        })
        .returning()

      if (!row) throw new Error('failed to create holder information request')

      await insertEvent(tx, tenantId, {
        holderInformationRequestId: requestId,
        eventType: 'created',
        fromState: null,
        toState: 'pending',
        actor,
        details: JSON.stringify({ type: create.type, purpose: create.purpose }),
      })

      return [row]
    })

    if (!inserted) {
      logServiceError('create', tenantId, new Error('insert returned no row'))
      throw new Error('failed to create holder information request')
    }

    return toDto(inserted)
  }

  const getHolderInformationRequest = async (
    actor: string,
    tenantId: string,
    requestId: string,
  ): Promise<HolderInformationRequestDto | null> => {
    const result = await withTenant(db, tenantId, async (tx) => {
      const current = await findRequestById(tx, tenantId, requestId)

      if (!current) return null

      const currentState = await expireIfNeeded(tx, tenantId, requestId, actor)

      if (currentState === null) return null

      const row = await findRequestById(tx, tenantId, requestId)

      if (!row) return null
      return toDto(row)
    })

    return result
  }

  const listHolderInformationRequests = async (
    actor: string,
    tenantId: string,
    opts: {
      readonly limit: number
      readonly offset: number
      readonly holderId?: string
      readonly state?: string
      readonly createdAfter?: string
      readonly createdBefore?: string
      readonly expiresBefore?: string
    },
  ): Promise<{
    requests: HolderInformationRequestDto[]
    total: number
    limit: number
    offset: number
  }> => {
    // Garantir que solicitações vencidas sejam persistidas como `expired`
    // antes da contagem e da listagem, preservando consistência e auditoria.
    await withTenant(db, tenantId, async (tx) => {
      await expireExpiredRequests(tx, tenantId, actor)
    })

    const conditions = [eq(t.holderInformationRequest.tenantId, tenantId)]

    if (opts.holderId) {
      conditions.push(eq(t.holderInformationRequest.holderId, opts.holderId))
    }
    if (opts.state) {
      conditions.push(eq(t.holderInformationRequest.state, opts.state))
    }
    if (opts.createdAfter) {
      conditions.push(sql`${t.holderInformationRequest.createdAt} > ${new Date(opts.createdAfter)}`)
    }
    if (opts.createdBefore) {
      conditions.push(sql`${t.holderInformationRequest.createdAt} < ${new Date(opts.createdBefore)}`)
    }
    if (opts.expiresBefore) {
      conditions.push(sql`${t.holderInformationRequest.expiresAt} < ${new Date(opts.expiresBefore)}`)
    }

    const [countRow] = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select({ count: count(t.holderInformationRequest.id).as('count') })
        .from(t.holderInformationRequest)
        .where(and(...conditions))
    })

    const total = Number((countRow?.count as unknown as number) ?? 0)

    const rows = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select()
        .from(t.holderInformationRequest)
        .where(and(...conditions))
        .orderBy(t.holderInformationRequest.createdAt)
        .limit(opts.limit)
        .offset(opts.offset)
    })

    return {
      requests: rows.map((row) => toDto(row)),
      total,
      limit: opts.limit,
      offset: opts.offset,
    }
  }

  const cancelHolderInformationRequest = async (
    actor: string,
    tenantId: string,
    requestId: string,
    transition: { readonly reason?: string },
  ): Promise<HolderInformationRequestDto> => {
    const [updated] = await withTenant(db, tenantId, async (tx) => {
      // Verificar se a solicitação existe e pertence ao tenant.
      const current = await findRequestById(tx, tenantId, requestId)

      if (!current) throw new Error('holder information request not found')

      const currentState = current.state as HolderInformationRequestState

      // Estados terminais não podem ser cancelados.
      if (!isExpirableState(currentState)) {
        throw new Error(`invalid state transition from '${currentState}' to 'cancelled'`)
      }

      // Cancelar apenas se o prazo ainda não venceu no momento efetivo da
      // operação. `expires_at > clock_timestamp()` (estrito) garante que a
      // igualdade já é tratada como prazo encerrado.
      const [row] = await tx
        .update(t.holderInformationRequest)
        .set({
          state: 'cancelled',
          cancelledAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(t.holderInformationRequest.id, requestId),
            eq(t.holderInformationRequest.tenantId, tenantId),
            eq(t.holderInformationRequest.state, currentState),
            sql`(${t.holderInformationRequest.expiresAt} IS NULL OR ${t.holderInformationRequest.expiresAt} > clock_timestamp())`,
          ),
        )
        .returning()

      if (!row) {
        // O UPDATE não afetou linhas porque o prazo venceu entre a leitura e o
        // UPDATE ou outra operação alterou o estado concorrentemente.
        const reloaded = await findRequestById(tx, tenantId, requestId)

        if (!reloaded) throw new Error('holder information request not found')

        const reloadedState = reloaded.state as HolderInformationRequestState

        // Se o prazo venceu e o estado ainda é passível de expiração, persistir
        // `expired` em vez de `cancelled`.
        if (
          reloaded.expiresAt !== null &&
          reloaded.expiresAt !== undefined &&
          isExpirableState(reloadedState)
        ) {
          const [expiredRow] = await tx
            .update(t.holderInformationRequest)
            .set({
              state: 'expired',
              expiredAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(t.holderInformationRequest.id, requestId),
                eq(t.holderInformationRequest.tenantId, tenantId),
                eq(t.holderInformationRequest.state, reloadedState),
                sql`${t.holderInformationRequest.expiresAt} <= clock_timestamp()`,
              ),
            )
            .returning()

          if (!expiredRow) throw new Error('concurrent state transition detected')

          await insertEvent(tx, tenantId, {
            holderInformationRequestId: requestId,
            eventType: 'expired',
            fromState: reloadedState,
            toState: 'expired',
            actor,
            details: JSON.stringify({ reason: 'expires_at vencido antes do cancelamento' }),
          })

          return [expiredRow]
        }

        // Estado terminal ou outro estado inválido para cancelamento.
        throw new Error(`invalid state transition from '${reloadedState}' to 'cancelled'`)
      }

      await insertEvent(tx, tenantId, {
        holderInformationRequestId: requestId,
        eventType: 'cancelled',
        fromState: currentState,
        toState: 'cancelled',
        actor,
        details: JSON.stringify({ reason: transition.reason }),
      })

      // Revogar todos os tokens ativos na mesma transação. A ordem de locks é
      // solicitação (UPDATE acima) → token.
      const revokedTokens = await tx
        .update(t.holderAccessToken)
        .set({ revokedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(t.holderAccessToken.tenantId, tenantId),
            eq(t.holderAccessToken.holderInformationRequestId, requestId),
            isNull(t.holderAccessToken.revokedAt),
          ),
        )
        .returning({ tokenId: t.holderAccessToken.tokenId })

      for (const token of revokedTokens) {
        await insertEvent(tx, tenantId, {
          holderInformationRequestId: requestId,
          eventType: 'access_token_revoked',
          fromState: 'cancelled',
          toState: 'cancelled',
          actor,
          details: JSON.stringify({ tokenId: token.tokenId, reason: 'request_cancelled' }),
        })
      }

      return [row]
    })

    if (!updated) {
      logServiceError('cancel', tenantId, new Error('update returned no row'))
      throw new Error('failed to cancel holder information request')
    }

    return toDto(updated)
  }

  return {
    createHolderInformationRequest,
    getHolderInformationRequest,
    listHolderInformationRequests,
    cancelHolderInformationRequest,
  }
}
