import { and, count, eq, isNotNull, sql, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { randomUUID } from 'node:crypto'
import type { Logger } from '@comprova/observability'
import {
  type HolderInformationRequestDto,
  type HolderInformationRequestState,
  type HolderInformationRequestItem,
  type HolderInformationRequestItems,
} from '@comprova/contracts'
import type { Db, DbTx } from '@comprova/db'

const errorNameOf = (error: unknown): string => (error instanceof Error ? error.name : 'unknown')

const errorCodeOf = (error: unknown, depth = 0): string | null => {
  if (depth > 3 || typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return code
  return errorCodeOf((error as { cause?: unknown }).cause, depth + 1)
}

const HOLDER_INFORMATION_REQUEST_STATE_TRANSITIONS: Record<
  HolderInformationRequestState,
  readonly HolderInformationRequestState[]
> = {
  pending: ['in_progress', 'completed', 'cancelled', 'expired'],
  in_progress: ['completed', 'cancelled', 'expired'],
  completed: [],
  cancelled: [],
  expired: [],
}

const isValidTransition = (
  fromState: HolderInformationRequestState | null,
  toState: HolderInformationRequestState,
): boolean => {
  if (fromState === null) return toState === 'pending'
  return HOLDER_INFORMATION_REQUEST_STATE_TRANSITIONS[fromState]?.includes(toState) ?? false
}

const isExpirableState = (state: HolderInformationRequestState): boolean => {
  return ['pending', 'in_progress'].includes(state)
}

/**
 * Busca o registro atual de uma solicitação dentro do tenant informado.
 * Retorna null se não existir ou não estiver acessível no tenant.
 */
const findRequestById = async (
  tx: DbTx,
  tenantId: string,
  requestId: string,
): Promise<{
  id: string
  tenantId: string
  holderId: string
  type: string
  purpose: string
  items: unknown
  state: string
  expiresAt: Date | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
  cancelledAt: Date | null
  expiredAt: Date | null
} | null> => {
  const [row] = await tx
    .select()
    .from(t.holderInformationRequest)
    .where(
      and(eq(t.holderInformationRequest.id, requestId), eq(t.holderInformationRequest.tenantId, tenantId)),
    )
    .limit(1)
  return row ?? null
}

export const makeHolderInformationRequestService = (deps: { readonly db: Db; readonly logger: Logger }) => {
  const { db, logger } = deps

  const insertEvent = async (
    tx: DbTx,
    tenantId: string,
    event: {
      readonly holderInformationRequestId: string
      readonly eventType: string
      readonly fromState: HolderInformationRequestState | null
      readonly toState: HolderInformationRequestState
      readonly actor: string
      readonly details: string
    },
  ): Promise<void> => {
    await tx.insert(t.holderInformationRequestEvent).values({
      id: randomUUID(),
      holderInformationRequestId: event.holderInformationRequestId,
      tenantId,
      eventType: event.eventType,
      fromState: event.fromState,
      toState: event.toState,
      actor: event.actor,
      details: event.details,
    })
  }

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

  /**
   * Persiste `expired` para todas as solicitações vencidas do tenant cujos
   * estados ainda são passíveis de expiração. Busca os candidatos primeiro e
   * depois atualiza individualmente, evitando uso de expressões SQL cruas no
   * UPDATE que poderiam não ser suportadas pelo driver.
   */
  const expireExpiredRequests = async (tx: DbTx, tenantId: string, actor: string): Promise<void> => {
    const now = new Date()

    const expiredCandidates = await tx
      .select({
        id: t.holderInformationRequest.id,
        state: t.holderInformationRequest.state,
        expiresAt: t.holderInformationRequest.expiresAt,
      })
      .from(t.holderInformationRequest)
      .where(
        and(
          eq(t.holderInformationRequest.tenantId, tenantId),
          isNotNull(t.holderInformationRequest.expiresAt),
        ),
      )

    const nowMs = now.getTime()
    for (const candidate of expiredCandidates) {
      const expiresAtMs = candidate.expiresAt?.getTime() ?? 0
      if (expiresAtMs >= nowMs) continue

      const previousState = candidate.state as HolderInformationRequestState
      if (!isExpirableState(previousState)) continue

      const [updated] = await tx
        .update(t.holderInformationRequest)
        .set({
          state: 'expired',
          expiredAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(t.holderInformationRequest.id, candidate.id),
            eq(t.holderInformationRequest.tenantId, tenantId),
            eq(t.holderInformationRequest.state, previousState),
          ),
        )
        .returning()

      if (!updated) continue

      await insertEvent(tx, tenantId, {
        holderInformationRequestId: candidate.id,
        eventType: 'expired',
        fromState: previousState,
        toState: 'expired',
        actor,
        details: JSON.stringify({ reason: 'expires_at vencido' }),
      })
    }
  }

  /**
   * Transiciona para `expired` quando o prazo venceu e o estado ainda é
   * passível de expiração. Executado dentro da transação do chamador.
   *
   * Se uma atualização concorrente alterar o registro antes do UPDATE, o
   * registro é reavaliado recursivamente e o estado efetivo é retornado.
   */
  const expireIfNeeded = async (
    tx: DbTx,
    tenantId: string,
    requestId: string,
    actor: string,
  ): Promise<HolderInformationRequestState | null> => {
    const current = await findRequestById(tx, tenantId, requestId)

    if (!current) return null

    const currentState = current.state as HolderInformationRequestState
    const now = new Date()

    if (
      current.expiresAt !== null &&
      current.expiresAt !== undefined &&
      current.expiresAt < now &&
      isExpirableState(currentState)
    ) {
      const [updated] = await tx
        .update(t.holderInformationRequest)
        .set({
          state: 'expired',
          expiredAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(t.holderInformationRequest.id, requestId),
            eq(t.holderInformationRequest.tenantId, tenantId),
            eq(t.holderInformationRequest.state, currentState),
          ),
        )
        .returning()

      if (!updated) {
        // Atualização concorrente: reavaliar o registro atual.
        return expireIfNeeded(tx, tenantId, requestId, actor)
      }

      await insertEvent(tx, tenantId, {
        holderInformationRequestId: requestId,
        eventType: 'expired',
        fromState: currentState,
        toState: 'expired',
        actor,
        details: JSON.stringify({ reason: 'expires_at vencido' }),
      })

      return 'expired'
    }

    return currentState
  }

  const toDto = (row: {
    id: string
    tenantId: string
    holderId: string
    type: string
    purpose: string
    items: unknown
    state: string
    expiresAt: Date | null
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
    const now = new Date()

    const [updated] = await withTenant(db, tenantId, async (tx) => {
      // Buscar o registro atual dentro da transação de cancelamento.
      const current = await findRequestById(tx, tenantId, requestId)

      if (!current) throw new Error('holder information request not found')

      const currentState = current.state as HolderInformationRequestState

      // Se a solicitação já estiver vencida, persistir `expired` em vez de `cancelled`.
      if (
        current.expiresAt !== null &&
        current.expiresAt !== undefined &&
        current.expiresAt < now &&
        isExpirableState(currentState)
      ) {
        const [expiredRow] = await tx
          .update(t.holderInformationRequest)
          .set({
            state: 'expired',
            expiredAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(t.holderInformationRequest.id, requestId),
              eq(t.holderInformationRequest.tenantId, tenantId),
              eq(t.holderInformationRequest.state, currentState),
            ),
          )
          .returning()

        if (!expiredRow) throw new Error('concurrent state transition detected')

        await insertEvent(tx, tenantId, {
          holderInformationRequestId: requestId,
          eventType: 'expired',
          fromState: currentState,
          toState: 'expired',
          actor,
          details: JSON.stringify({
            reason: 'expires_at vencido antes do cancelamento',
          }),
        })

        return [expiredRow]
      }

      if (!isValidTransition(currentState, 'cancelled')) {
        throw new Error(`invalid state transition from '${currentState}' to 'cancelled'`)
      }

      const [row] = await tx
        .update(t.holderInformationRequest)
        .set({
          state: 'cancelled',
          cancelledAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(t.holderInformationRequest.id, requestId),
            eq(t.holderInformationRequest.tenantId, tenantId),
            eq(t.holderInformationRequest.state, currentState),
          ),
        )
        .returning()

      if (!row) throw new Error('concurrent state transition detected')

      await insertEvent(tx, tenantId, {
        holderInformationRequestId: requestId,
        eventType: 'cancelled',
        fromState: currentState,
        toState: 'cancelled',
        actor,
        details: JSON.stringify({ reason: transition.reason }),
      })

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
