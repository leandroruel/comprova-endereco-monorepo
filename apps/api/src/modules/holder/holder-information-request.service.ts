import { and, count, eq, sql, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { randomUUID } from 'node:crypto'
import {
  type HolderInformationRequestDto,
  type HolderInformationRequestState,
  type HolderInformationRequestItem,
  type HolderInformationRequestItems,
} from '@comprova/contracts'
import type { Db, DbTx } from '@comprova/db'

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

export const makeHolderInformationRequestService = (deps: { readonly db: Db }) => {
  const { db } = deps

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

  /**
   * Transiciona para `expired` quando o prazo venceu e o estado ainda é
   * passível de expiração. Executado dentro da transação do chamador.
   */
  const expireIfNeeded = async (
    tx: DbTx,
    tenantId: string,
    requestId: string,
    actor: string,
  ): Promise<HolderInformationRequestState | null> => {
    const [current] = await tx
      .select()
      .from(t.holderInformationRequest)
      .where(
        and(eq(t.holderInformationRequest.id, requestId), eq(t.holderInformationRequest.tenantId, tenantId)),
      )
      .limit(1)

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

      if (!updated) return null

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
      readonly holderId: string
      readonly type: string
      readonly purpose: string
      readonly items: HolderInformationRequestItems
      readonly expiresAt?: string
    },
  ): Promise<HolderInformationRequestDto> => {
    // Validar que o holder pertence ao tenant informado (mesma transação).
    const existingHolder = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select({ holderId: t.holder.holderId, tenantId: t.holder.tenantId })
        .from(t.holder)
        .where(and(eq(t.holder.holderId, create.holderId), eq(t.holder.tenantId, tenantId)))
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
    const now = new Date()

    const [inserted] = await withTenant(db, tenantId, async (tx) => {
      const [row] = await tx
        .insert(t.holderInformationRequest)
        .values({
          id: requestId,
          tenantId,
          holderId: create.holderId,
          type: create.type,
          purpose: create.purpose,
          items: create.items,
          state: 'pending' as HolderInformationRequestState,
          expiresAt: create.expiresAt ? new Date(create.expiresAt) : null,
          createdBy: actor,
          createdAt: now,
          updatedAt: now,
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

    if (!inserted) throw new Error('failed to create holder information request')

    return toDto(inserted)
  }

  const getHolderInformationRequest = async (
    actor: string,
    tenantId: string,
    requestId: string,
  ): Promise<HolderInformationRequestDto | null> => {
    const result = await withTenant(db, tenantId, async (tx) => {
      const [current] = await tx
        .select()
        .from(t.holderInformationRequest)
        .where(
          and(
            eq(t.holderInformationRequest.id, requestId),
            eq(t.holderInformationRequest.tenantId, tenantId),
          ),
        )
        .limit(1)

      if (!current) return null

      const currentState = await expireIfNeeded(tx, tenantId, requestId, actor)

      if (currentState === null) return null

      const [row] = await tx
        .select()
        .from(t.holderInformationRequest)
        .where(
          and(
            eq(t.holderInformationRequest.id, requestId),
            eq(t.holderInformationRequest.tenantId, tenantId),
          ),
        )
        .limit(1)

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
    // Obter estado atual com verificação de tenant.
    const current = await getHolderInformationRequest(actor, tenantId, requestId)
    if (!current) throw new Error('holder information request not found')

    if (!isValidTransition(current.state, 'cancelled')) {
      throw new Error(`invalid state transition from '${current.state}' to 'cancelled'`)
    }

    const now = new Date()

    const [updated] = await withTenant(db, tenantId, async (tx) => {
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
            eq(t.holderInformationRequest.state, current.state),
          ),
        )
        .returning()

      if (!row) throw new Error('concurrent state transition detected')

      await insertEvent(tx, tenantId, {
        holderInformationRequestId: requestId,
        eventType: 'cancelled',
        fromState: current.state,
        toState: 'cancelled',
        actor,
        details: JSON.stringify({ reason: transition.reason }),
      })

      return [row]
    })

    if (!updated) throw new Error('failed to cancel holder information request')

    return toDto(updated)
  }

  return {
    createHolderInformationRequest,
    getHolderInformationRequest,
    listHolderInformationRequests,
    cancelHolderInformationRequest,
  }
}
