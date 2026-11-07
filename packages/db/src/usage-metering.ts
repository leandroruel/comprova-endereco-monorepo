import { and, eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { DbTx } from './client.js'
import * as t from './schemas/index.js'

/** Erro lançado quando a cota hard do tenant está atingida. */
export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuotaExceededError'
  }
}

/** Percentual de consumo a partir do qual a cota soft é considerada atingida. */
export const SOFT_THRESHOLD_PERCENT = 80

/** Período de referência padrão: mês corrente. */
export const defaultPeriod = (): { readonly start: Date; readonly end: Date } => {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { start, end }
}

/** Resultado da gravação de evento de uso. */
export interface UsageEventRecorded {
  readonly eventId: string | null
  readonly replayed: boolean
}

/**
 * Chave comercial canônica da unidade faturável de uma validação
 * (ADR-0044 §3): compartilhada por TODOS os caminhos técnicos (fast, deep).
 * Usada apenas para eventos FATURÁVEIS — eventos técnicos/tentativas usam
 * chaves próprias para nunca bloquearem um faturamento legítimo posterior.
 */
export const validationBillingKey = (validationId: string): string => `validation:${validationId}`

/**
 * Insere um evento de uso dentro de uma transação existente (tx já tem
 * contexto de tenant via `withTenant`).
 *
 * Ordem de operações (concorrência segura):
 * 1. Reservar/inserir a chave de idempotência em `usage_event_idempotency`.
 * 2. Se for replay (chave já existente), retornar o evento previamente
 *    registrado SEM consumir cota novamente (`replayed: true`).
 * 3. Se o evento é FATURÁVEL e tem `validationId`, reservar a identidade
 *    comercial em `usage_billing_unit` (PK `tenant_id + validation_id`,
 *    `ON CONFLICT DO NOTHING`). Se outra execução (fast ou deep, qualquer
 *    chave) já faturou esta validação, retornar o evento dela como replay —
 *    garantia estrutural do banco: no máximo uma unidade faturável por
 *    `tenantId + validationId` (ADR-0044 §3).
 * 4. Se for uma operação nova, verificar a cota hard.
 * 5. Registrar o evento e atualizar as referências (idempotência e identidade
 *    comercial).
 * 6. Tudo permanece na mesma transação da operação de negócio.
 */
export const recordUsageEventInTx = async (
  tx: DbTx,
  input: {
    readonly tenantId: string
    readonly eventType: string
    readonly kind: string
    readonly units?: number
    readonly costMicros?: number | null
    readonly validationId?: string | null
    readonly idempotencyKey?: string | null
    readonly billable?: boolean
    readonly source?: string | null
  },
): Promise<UsageEventRecorded> => {
  const {
    tenantId,
    eventType,
    kind,
    units = 1,
    costMicros = null,
    validationId = null,
    idempotencyKey = null,
    billable = false,
    source = null,
  } = input

  const key = idempotencyKey ?? randomUUID()
  const eventId = randomUUID()

  // Concorrência segura: bloqueia a linha do tenant para impedir que duas
  // requisições simultâneas ultrapassem silenciosamente um limite hard.
  await tx.execute(sql`SELECT 1 FROM tenant WHERE tenant_id = ${tenantId} FOR UPDATE`)

  // 1. Reservar/inserir a chave de idempotência (única por tenant+chave).
  const idemRows = await tx
    .insert(t.usageEventIdempotency)
    .values({
      tenantId,
      idempotencyKey: key,
      eventId: null,
    })
    .onConflictDoNothing()
    .returning({ idempotencyKey: t.usageEventIdempotency.idempotencyKey })

  // 2. Replay: outra transação (ou execução prévia) já registrou esta chave.
  if (idemRows.length === 0) {
    const existing = await tx
      .select({ eventId: t.usageEventIdempotency.eventId })
      .from(t.usageEventIdempotency)
      .where(
        and(eq(t.usageEventIdempotency.tenantId, tenantId), eq(t.usageEventIdempotency.idempotencyKey, key)),
      )
      .limit(1)
    return {
      eventId: existing[0]?.eventId ?? null,
      replayed: true,
    }
  }

  // 3. Evento faturável com validação: reservar a identidade comercial
  //    (garantia no BANCO de uma única unidade faturável por
  //    tenant + validation, independente da chave de idempotência usada).
  let billingUnitClaimed = false
  if (billable && validationId !== null) {
    const claimed = await tx
      .insert(t.usageBillingUnit)
      .values({ tenantId, validationId, eventId: null })
      .onConflictDoNothing()
      .returning({ validationId: t.usageBillingUnit.validationId })

    if (claimed.length === 0) {
      // Outra execução (fast ou deep, com qualquer chave) já faturou esta
      // validação. Retornar o evento dela SEM consumir cota nem duplicar
      // evento. O lock do tenant (FOR UPDATE acima) serializa as duas
      // transações, então o `event_id` já foi preenchido pela vencedora.
      const existingUnit = await tx
        .select({ eventId: t.usageBillingUnit.eventId })
        .from(t.usageBillingUnit)
        .where(
          and(eq(t.usageBillingUnit.tenantId, tenantId), eq(t.usageBillingUnit.validationId, validationId)),
        )
        .limit(1)
      // Mapeia também a chave reservada neste fluxo para o evento vencedor,
      // para que retries com esta chave sejam reconhecidos como replay.
      const winnerEventId = existingUnit[0]?.eventId ?? null
      if (winnerEventId !== null) {
        await tx
          .update(t.usageEventIdempotency)
          .set({ eventId: winnerEventId })
          .where(
            and(
              eq(t.usageEventIdempotency.tenantId, tenantId),
              eq(t.usageEventIdempotency.idempotencyKey, key),
            ),
          )
      }
      return { eventId: winnerEventId, replayed: true }
    }
    billingUnitClaimed = true
  }

  // 4. Operação nova: verificar cota hard ANTES de gravar evento faturável.
  if (billable) {
    const tenantRow = await tx
      .select({ monthlyQuota: t.tenant.monthlyQuota })
      .from(t.tenant)
      .where(eq(t.tenant.tenantId, tenantId))
      .limit(1)

    if (tenantRow[0]?.monthlyQuota !== null && tenantRow[0]?.monthlyQuota !== undefined) {
      const quota = Number(tenantRow[0].monthlyQuota)
      const { start, end } = defaultPeriod()
      // Bind como string ISO para evitar erro de serialização do driver com Date.
      const startStr = start.toISOString()
      const endStr = end.toISOString()
      const consumed = await tx
        .select({
          total: sql<number>`COALESCE(sum(units), 0)::int`,
        })
        .from(t.usageEvent)
        .where(
          and(
            eq(t.usageEvent.tenantId, tenantId),
            eq(t.usageEvent.billable, true),
            sql`usage_event.occurred_at >= ${startStr}`,
            sql`usage_event.occurred_at < ${endStr}`,
          ),
        )
      const consumedUnits = Number(consumed[0]?.total ?? 0)
      if (consumedUnits + units > quota) {
        throw new QuotaExceededError(
          `Cota hard atingida: consumido ${consumedUnits}/${quota} unidades no período.`,
        )
      }
    }
  }

  // 5. Registrar o evento de uso e atualizar as referências (idempotência e
  //    identidade comercial).
  const inserted = await tx
    .insert(t.usageEvent)
    .values({
      eventId,
      tenantId,
      eventType,
      kind,
      units,
      costMicros: costMicros ?? null,
      validationId: validationId ?? null,
      idempotencyKey: key,
      billable,
      source: source ?? null,
    })
    .returning({ eventId: t.usageEvent.eventId })

  const persistedEventId = inserted[0]?.eventId ?? null
  if (persistedEventId !== null) {
    await tx
      .update(t.usageEventIdempotency)
      .set({ eventId: persistedEventId })
      .where(
        and(eq(t.usageEventIdempotency.tenantId, tenantId), eq(t.usageEventIdempotency.idempotencyKey, key)),
      )
    if (billingUnitClaimed) {
      await tx
        .update(t.usageBillingUnit)
        .set({ eventId: persistedEventId })
        .where(
          and(eq(t.usageBillingUnit.tenantId, tenantId), eq(t.usageBillingUnit.validationId, validationId!)),
        )
    }
  }

  return { eventId: persistedEventId, replayed: false }
}
