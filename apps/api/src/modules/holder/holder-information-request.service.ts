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
   * estados ainda são passíveis de expiração.
   *
   * O filtro de prazo é aplicado diretamente no PostgreSQL com
   * `clock_timestamp()`, evitando carregar todo o histórico do tenant.
   * Há um UPDATE por estado de origem (`pending`, `in_progress`): o RETURNING
   * de um UPDATE devolve os valores pós-atualização, então um único UPDATE em
   * lote informaria `fromState: 'expired'` para toda linha, perdendo o estado
   * verdadeiro do evento de auditoria. A atomicidade e o isolamento por tenant
   * via RLS permanecem.
   */
  const expireExpiredRequests = async (tx: DbTx, tenantId: string, actor: string): Promise<void> => {
    // clock_timestamp() retorna o momento efetivo da execução da instrução
    // SQL no banco, consistente com o relógio do PostgreSQL.
    for (const fromState of ['pending', 'in_progress'] as const) {
      const updatedRows = await tx
        .update(t.holderInformationRequest)
        .set({
          state: 'expired',
          expiredAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(t.holderInformationRequest.tenantId, tenantId),
            eq(t.holderInformationRequest.state, fromState),
            isNotNull(t.holderInformationRequest.expiresAt),
            sql`${t.holderInformationRequest.expiresAt} < clock_timestamp()`,
          ),
        )
        .returning({ id: t.holderInformationRequest.id })

      // Insere eventos de auditoria para cada transição efetivamente realizada.
      for (const row of updatedRows) {
        await insertEvent(tx, tenantId, {
          holderInformationRequestId: row.id,
          eventType: 'expired',
          fromState,
          toState: 'expired',
          actor,
          details: JSON.stringify({ reason: 'expires_at vencido' }),
        })
      }
    }
  }

  /**
   * Transiciona para `expired` quando o prazo venceu e o estado ainda é
   * passível de expiração. Executado dentro da transação do chamador.
   *
   * Se o UPDATE condicional não afetar linhas — prazo empurrado para o futuro
   * por outra operação ou transição concorrente entre a leitura e o UPDATE —
   * o registro é recarregado e o estado vigente é retornado, sem repetir o
   * ciclo de expiração.
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

    if (!isExpirableState(currentState)) {
      return currentState
    }

    if (current.expiresAt === null || current.expiresAt === undefined) {
      return currentState
    }

    const [updated] = await tx
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
          eq(t.holderInformationRequest.state, currentState),
          sql`${t.holderInformationRequest.expiresAt} < clock_timestamp()`,
        ),
      )
      .returning()

    if (updated) {
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

    // O UPDATE não afetou linhas: o prazo não venceu (ex.: empurrado para o
    // futuro por outra operação) ou o estado mudou concorrentemente entre a
    // leitura e o UPDATE. Reavalia uma única vez com o estado vigente.
    const reloaded = await findRequestById(tx, tenantId, requestId)

    if (!reloaded) return null

    return reloaded.state as HolderInformationRequestState
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
    const [updated] = await withTenant(db, tenantId, async (tx) => {
      // Verificar se a solicitação existe e pertence ao tenant.
      const current = await findRequestById(tx, tenantId, requestId)

      if (!current) throw new Error('holder information request not found')

      const currentState = current.state as HolderInformationRequestState

      // Estados terminais não podem ser cancelados.
      if (!isExpirableState(currentState)) {
        throw new Error(`invalid state transition from '${currentState}' to 'cancelled'`)
      }

      // Tentar cancelar apenas se o prazo ainda não venceu no momento
      // efetivo da operação. A condição `expires_at IS NULL OR expires_at >=
      // clock_timestamp()` é avaliada pelo PostgreSQL dentro do UPDATE,
      // evitando corrida entre leitura e escrita.
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
            // Apenas cancela se o prazo não venceu. clock_timestamp() é a
            // hora efetiva de execução da instrução SQL no banco. O OR é
            // agrupado explicitamente para não escapar das condições de ID,
            // tenant e estado.
            sql`(${t.holderInformationRequest.expiresAt} IS NULL OR ${t.holderInformationRequest.expiresAt} >= clock_timestamp())`,
          ),
        )
        .returning()

      if (!row) {
        // O UPDATE não afetou linhas porque:
        // 1) o prazo venceu entre a leitura e o UPDATE (outra operação
        //    já expirou a solicitação), ou
        // 2) outra operação alterou o estado concorrentemente.
        // Recarregar e reavaliar.
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
                isNotNull(t.holderInformationRequest.expiresAt),
                sql`${t.holderInformationRequest.expiresAt} < clock_timestamp()`,
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
