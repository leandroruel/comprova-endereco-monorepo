import { and, eq, isNotNull, sql, type DbTx } from '@comprova/db'
import * as t from '@comprova/db'
import type { HolderInformationRequestState } from '@comprova/contracts'
import { randomUUID } from 'node:crypto'

/**
 * Peças compartilhadas entre a API do Verifier (F4.1) e o acesso do Holder
 * (F4.2).
 *
 * A semântica de expiração é única: operações são válidas enquanto
 * `expires_at IS NULL OR expires_at > clock_timestamp()`; a persistência de
 * `expired` acontece quando `expires_at <= clock_timestamp()`. O evento é
 * sempre inserido na mesma transação da transição.
 */

export interface HolderInformationRequestRow {
  readonly id: string
  readonly tenantId: string
  readonly holderId: string
  readonly type: string
  readonly purpose: string
  readonly items: unknown
  readonly state: string
  readonly expiresAt: Date | null
  readonly createdBy: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly completedAt: Date | null
  readonly cancelledAt: Date | null
  readonly expiredAt: Date | null
}

export const isExpirableState = (state: HolderInformationRequestState): boolean =>
  state === 'pending' || state === 'in_progress'

export const findRequestById = async (
  tx: DbTx,
  tenantId: string,
  requestId: string,
): Promise<HolderInformationRequestRow | null> => {
  const [row] = await tx
    .select()
    .from(t.holderInformationRequest)
    .where(
      and(eq(t.holderInformationRequest.id, requestId), eq(t.holderInformationRequest.tenantId, tenantId)),
    )
    .limit(1)
  return row ?? null
}

/**
 * Lê a solicitação já sob lock de linha. Usado por todas as mutações do Holder,
 * pela emissão de token e pelo primeiro acesso. A ordem de locks é sempre
 * solicitação → token.
 */
export const lockRequestById = async (
  tx: DbTx,
  tenantId: string,
  requestId: string,
): Promise<HolderInformationRequestRow | null> => {
  const [row] = await tx
    .select()
    .from(t.holderInformationRequest)
    .where(
      and(eq(t.holderInformationRequest.id, requestId), eq(t.holderInformationRequest.tenantId, tenantId)),
    )
    .limit(1)
    .for('update')
  return row ?? null
}

export const insertHolderInformationRequestEvent = async (
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
 * Persiste `expired` para todas as solicitações vencidas do tenant cujos
 * estados ainda são passíveis de expiração.
 */
export const expireExpiredRequests = async (tx: DbTx, tenantId: string, actor: string): Promise<void> => {
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
          sql`${t.holderInformationRequest.expiresAt} <= clock_timestamp()`,
        ),
      )
      .returning({ id: t.holderInformationRequest.id })

    for (const row of updatedRows) {
      await insertHolderInformationRequestEvent(tx, tenantId, {
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
 * O chamador que já detém o lock da solicitação (F4.2) obtém o mesmo
 * resultado; a função não abre transação própria. Nunca lança depois de
 * escrever: o retorno normal é o que commita a transição e o evento.
 */
export const expireIfNeeded = async (
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
        sql`${t.holderInformationRequest.expiresAt} <= clock_timestamp()`,
      ),
    )
    .returning()

  if (updated) {
    await insertHolderInformationRequestEvent(tx, tenantId, {
      holderInformationRequestId: requestId,
      eventType: 'expired',
      fromState: currentState,
      toState: 'expired',
      actor,
      details: JSON.stringify({ reason: 'expires_at vencido' }),
    })

    return 'expired'
  }

  const reloaded = await findRequestById(tx, tenantId, requestId)

  if (!reloaded) return null

  return reloaded.state as HolderInformationRequestState
}
