import { and, desc, eq, sql, withTenant } from '@comprova/db'
import type { Db, DbTx } from '@comprova/db'
import * as t from '@comprova/db'
import { randomUUID } from 'node:crypto'
import type { UsageConsumptionQuery, UsageEventsQuery } from './usage.schema.js'

/** Erro lançado quando a cota hard do tenant está atingida. */
export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuotaExceededError'
  }
}

/** Percentual de consumo a partir do qual a cota soft é considerada atingida. */
const SOFT_THRESHOLD_PERCENT = 80

/** Período de referência padrão: mês corrente. */
const defaultPeriod = (): { readonly start: Date; readonly end: Date } => {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { start, end }
}

const parseDate = (value: string | undefined): Date | undefined => {
  if (!value) return undefined
  const d = new Date(value)
  return isNaN(d.getTime()) ? undefined : d
}

/** Resultado da gravação de evento de uso. */
export interface UsageEventRecorded {
  readonly eventId: string | null
  readonly replayed: boolean
}

/**
 * Insere um evento de uso dentro de uma transação existente (tx já tem
 * contexto de tenant via `withTenant`).
 *
 * - Idempotência: verifica/registra a chave em `usage_event_idempotency`
 *   dentro da mesma transação. Concorrência segura via PK composta.
 * - Se `billable = true` e cota hard atingida, lança `QuotaExceededError`.
 * - Retorna `{ eventId, replayed }`.
 */
const recordUsageEventInTx = async (
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

  // Concorrência segura: bloqueia a linha do tenant para impedir que duas
  // requisições simultâneas ultrapassem silenciosamente um limite hard.
  await tx.execute(sql`SELECT 1 FROM tenant WHERE tenant_id = ${tenantId} FOR UPDATE`)

  // Verificação de cota hard ANTES de gravar evento faturável.
  if (billable) {
    const tenantRow = await tx
      .select({ monthlyQuota: t.tenant.monthlyQuota })
      .from(t.tenant)
      .where(eq(t.tenant.tenantId, tenantId))
      .limit(1)

    if (tenantRow[0]?.monthlyQuota !== null && tenantRow[0]?.monthlyQuota !== undefined) {
      const quota = Number(tenantRow[0].monthlyQuota)
      const { start, end } = defaultPeriod()
      const consumed = await tx
        .select({
          total: sql<number>`COALESCE(sum(units), 0)::int`,
        })
        .from(t.usageEvent)
        .where(
          and(
            eq(t.usageEvent.tenantId, tenantId),
            eq(t.usageEvent.billable, true),
            sql`usage_event.occurred_at >= ${start}`,
            sql`usage_event.occurred_at < ${end}`,
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

  // Idempotência: tenta registrar a chave. Se já existe (conflito de PK),
  // é um replay — não grava novo evento.
  const idemRows = await tx
    .insert(t.usageEventIdempotency)
    .values({
      tenantId,
      idempotencyKey: key,
      eventId: null,
    })
    .onConflictDoNothing()
    .returning({ idempotencyKey: t.usageEventIdempotency.idempotencyKey })

  if (idemRows.length === 0) {
    // Replay: outra transação já registrou esta chave.
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

  // Insere o evento de uso.
  const inserted = await tx
    .insert(t.usageEvent)
    .values({
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

  const eventId = inserted[0]?.eventId ?? null

  // Atualiza referência do evento na linha de idempotência.
  if (eventId !== null) {
    await tx
      .update(t.usageEventIdempotency)
      .set({ eventId })
      .where(
        and(eq(t.usageEventIdempotency.tenantId, tenantId), eq(t.usageEventIdempotency.idempotencyKey, key)),
      )
  }

  return { eventId, replayed: false }
}

interface UsageServiceDeps {
  readonly db: Db
}

export const makeUsageService = (deps: UsageServiceDeps) => {
  const { db } = deps

  /**
   * Registra um evento de uso de forma idempotente (nova transação via
   * `withTenant`). Use `recordUsageEventInTx` quando já houver transação aberta.
   */
  const recordUsageEvent = async (input: {
    readonly tenantId: string
    readonly eventType: string
    readonly kind: string
    readonly units?: number
    readonly costMicros?: number | null
    readonly validationId?: string | null
    readonly idempotencyKey?: string | null
    readonly billable?: boolean
    readonly source?: string | null
  }): Promise<UsageEventRecorded> => {
    return withTenant(db, input.tenantId, async (tx) => {
      return recordUsageEventInTx(tx, input)
    })
  }

  /**
   * Consulta o consumo agregado de um tenant em um período.
   */
  const getConsumption = async (
    tenantId: string,
    query: UsageConsumptionQuery,
  ): Promise<{
    readonly tenantId: string
    readonly periodStart: string
    readonly periodEnd: string
    readonly totalEvents: number
    readonly totalUnits: number
    readonly totalBillableUnits: number
    readonly totalCostMicros: number | null
    readonly byEventType: Record<string, number>
  }> => {
    const { start, end } = defaultPeriod()
    const periodStart = parseDate(query.periodStart) ?? start
    const periodEnd = parseDate(query.periodEnd) ?? end

    return withTenant(db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          eventType: t.usageEvent.eventType,
          count: sql<number>`count(*)::int`,
          units: sql<number>`COALESCE(sum(units), 0)::int`,
          billableUnits: sql<number>`COALESCE(sum(CASE WHEN billable THEN units ELSE 0 END), 0)::int`,
          costMicros: sql<number | null>`COALESCE(sum(cost_micros), 0)`,
        })
        .from(t.usageEvent)
        .where(
          and(
            eq(t.usageEvent.tenantId, tenantId),
            sql`usage_event.occurred_at >= ${periodStart}`,
            sql`usage_event.occurred_at < ${periodEnd}`,
          ),
        )
        .groupBy(t.usageEvent.eventType)

      let totalEvents = 0
      let totalUnits = 0
      let totalBillableUnits = 0
      let totalCostMicros = 0
      const byEventType: Record<string, number> = {}

      for (const row of rows) {
        const cnt = Number(row.count)
        totalEvents += cnt
        totalUnits += Number(row.units)
        totalBillableUnits += Number(row.billableUnits)
        totalCostMicros += Number(row.costMicros ?? 0)
        byEventType[row.eventType] = (byEventType[row.eventType] ?? 0) + cnt
      }

      return {
        tenantId,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        totalEvents,
        totalUnits,
        totalBillableUnits,
        totalCostMicros: totalCostMicros > 0 ? totalCostMicros : null,
        byEventType,
      }
    })
  }

  /**
   * Consulta a situação da cota de um tenant no período corrente.
   */
  const getQuota = async (
    tenantId: string,
  ): Promise<{
    readonly tenantId: string
    readonly monthlyQuota: number | null
    readonly consumedUnits: number
    readonly remainingUnits: number | null
    readonly hasHardLimit: boolean
    readonly softThresholdPercent: number | null
    readonly isSoftLimitReached: boolean
    readonly isHardLimitReached: boolean
    readonly periodStart: string
    readonly periodEnd: string
  }> => {
    return withTenant(db, tenantId, async (tx) => {
      const tenantRow = await tx
        .select({ monthlyQuota: t.tenant.monthlyQuota })
        .from(t.tenant)
        .where(eq(t.tenant.tenantId, tenantId))
        .limit(1)

      const monthlyQuota =
        tenantRow[0]?.monthlyQuota === null || tenantRow[0]?.monthlyQuota === undefined
          ? null
          : Number(tenantRow[0].monthlyQuota)

      const { start, end } = defaultPeriod()
      const consumed = await tx
        .select({
          total: sql<number>`COALESCE(sum(units), 0)::int`,
        })
        .from(t.usageEvent)
        .where(
          and(
            eq(t.usageEvent.tenantId, tenantId),
            eq(t.usageEvent.billable, true),
            sql`usage_event.occurred_at >= ${start}`,
            sql`usage_event.occurred_at < ${end}`,
          ),
        )
      const consumedUnits = Number(consumed[0]?.total ?? 0)

      const hasHardLimit = monthlyQuota !== null
      const remainingUnits = hasHardLimit ? Math.max(0, monthlyQuota - consumedUnits) : null
      const softThreshold = hasHardLimit ? Math.floor((monthlyQuota * SOFT_THRESHOLD_PERCENT) / 100) : null
      const isSoftLimitReached =
        hasHardLimit && consumedUnits >= softThreshold! && consumedUnits < monthlyQuota
      const isHardLimitReached = hasHardLimit && consumedUnits >= monthlyQuota

      return {
        tenantId,
        monthlyQuota,
        consumedUnits,
        remainingUnits,
        hasHardLimit,
        softThresholdPercent: softThreshold ?? null,
        isSoftLimitReached,
        isHardLimitReached,
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
      }
    })
  }

  /**
   * Lista eventos de uso de um tenant com filtros opcionais.
   */
  const getEvents = async (
    tenantId: string,
    query: UsageEventsQuery,
  ): Promise<{
    readonly events: {
      readonly eventId: string | null
      readonly occurredAt: string
      readonly eventType: string
      readonly kind: string
      readonly units: number
      readonly costMicros: number | null
      readonly validationId: string | null
      readonly idempotencyKey: string | null
      readonly billable: boolean
      readonly source: string | null
    }[]
    readonly total: number
    readonly limit: number
    readonly offset: number
  }> => {
    const { limit = 50, offset = 0 } = query
    const { start, end } = defaultPeriod()
    const periodStart = parseDate(query.periodStart) ?? start
    const periodEnd = parseDate(query.periodEnd) ?? end

    return withTenant(db, tenantId, async (tx) => {
      const conditions = [
        eq(t.usageEvent.tenantId, tenantId),
        sql`usage_event.occurred_at >= ${periodStart}`,
        sql`usage_event.occurred_at < ${periodEnd}`,
      ]

      if (query.billable !== undefined) {
        conditions.push(eq(t.usageEvent.billable, query.billable))
      }
      if (query.eventType) {
        conditions.push(eq(t.usageEvent.eventType, query.eventType))
      }

      const base = tx
        .select({
          eventId: t.usageEvent.eventId,
          occurredAt: t.usageEvent.occurredAt,
          eventType: t.usageEvent.eventType,
          kind: t.usageEvent.kind,
          units: t.usageEvent.units,
          costMicros: t.usageEvent.costMicros,
          validationId: t.usageEvent.validationId,
          idempotencyKey: t.usageEvent.idempotencyKey,
          billable: t.usageEvent.billable,
          source: t.usageEvent.source,
        })
        .from(t.usageEvent)
        .where(and(...conditions))

      const [rows, totalRow] = await Promise.all([
        base.orderBy(desc(t.usageEvent.occurredAt)).limit(limit).offset(offset),
        tx
          .select({ total: sql<number>`count(*)::int` })
          .from(t.usageEvent)
          .where(
            and(
              eq(t.usageEvent.tenantId, tenantId),
              sql`usage_event.occurred_at >= ${periodStart}`,
              sql`usage_event.occurred_at < ${periodEnd}`,
            ),
          ),
      ])

      const total = Number(totalRow[0]?.total ?? 0)

      return {
        events: rows.map((row) => ({
          eventId: row.eventId ?? null,
          occurredAt: row.occurredAt.toISOString(),
          eventType: row.eventType,
          kind: row.kind,
          units: Number(row.units),
          costMicros: row.costMicros === null ? null : Number(row.costMicros),
          validationId: row.validationId ?? null,
          idempotencyKey: row.idempotencyKey ?? null,
          billable: Boolean(row.billable),
          source: row.source ?? null,
        })),
        total,
        limit,
        offset,
      }
    })
  }

  /**
   * Reconcilia validações concluídas com eventos de uso registrados.
   *
   * Identifica divergências sem corrigi-las silenciosamente.
   */
  const reconcile = async (
    tenantId: string,
    periodStart?: string,
    periodEnd?: string,
  ): Promise<{
    readonly tenantId: string
    readonly periodStart: string
    readonly periodEnd: string
    readonly completedValidations: number
    readonly usageEvents: number
    readonly billableEvents: number
    readonly divergences: {
      type:
        | 'validation_without_event'
        | 'duplicate_event'
        | 'event_without_validation'
        | 'unit_mismatch'
        | 'billability_mismatch'
      validationId: string | null
      description: string
    }[]
  }> => {
    const { start, end } = defaultPeriod()
    const ps = parseDate(periodStart) ?? start
    const pe = parseDate(periodEnd) ?? end

    return withTenant(db, tenantId, async (tx) => {
      // Validações concluídas no período.
      const completedValidations = await tx
        .select({
          id: t.validation.validationId,
          status: t.validation.status,
        })
        .from(t.validation)
        .where(
          and(
            eq(t.validation.tenantId, tenantId),
            eq(t.validation.status, 'completed'),
            sql`validation.created_at >= ${ps}`,
            sql`validation.created_at < ${pe}`,
          ),
        )

      // Eventos de uso no período.
      const usageEvents = await tx
        .select({
          id: t.usageEvent.idempotencyKey,
          validationId: t.usageEvent.validationId,
          billable: t.usageEvent.billable,
          units: t.usageEvent.units,
        })
        .from(t.usageEvent)
        .where(
          and(
            eq(t.usageEvent.tenantId, tenantId),
            sql`usage_event.occurred_at >= ${ps}`,
            sql`usage_event.occurred_at < ${pe}`,
          ),
        )

      const completedIds = new Set(completedValidations.map((v) => v.id))
      const validationIdsWithEvent = new Set(
        usageEvents.map((e) => e.validationId).filter((id): id is string => id !== null),
      )

      const divergences: {
        type:
          | 'validation_without_event'
          | 'duplicate_event'
          | 'event_without_validation'
          | 'unit_mismatch'
          | 'billability_mismatch'
        validationId: string | null
        description: string
      }[] = []

      // Validações concluídas sem evento de uso.
      for (const v of completedValidations) {
        if (!validationIdsWithEvent.has(v.id)) {
          divergences.push({
            type: 'validation_without_event',
            validationId: v.id,
            description: `Validação concluída ${v.id} não possui evento de uso associado.`,
          })
        }
      }

      // Eventos sem validação correspondente.
      for (const e of usageEvents) {
        if (e.validationId && !completedIds.has(e.validationId)) {
          divergences.push({
            type: 'event_without_validation',
            validationId: e.validationId,
            description: `Evento de uso ${e.id} referencia validação ${e.validationId} não concluída.`,
          })
        }
      }

      // Eventos duplicados (mesma validation_id com múltiplos eventos faturáveis).
      const billableByValidation = new Map<string, { count: number; units: number }>()
      for (const e of usageEvents) {
        if (e.validationId && e.billable) {
          const existing = billableByValidation.get(e.validationId)
          if (existing) {
            existing.count += 1
            existing.units += Number(e.units)
          } else {
            billableByValidation.set(e.validationId, { count: 1, units: Number(e.units) })
          }
        }
      }
      for (const [vid, info] of billableByValidation) {
        if (info.count > 1) {
          divergences.push({
            type: 'duplicate_event',
            validationId: vid,
            description: `Validação ${vid} possui ${info.count} eventos faturáveis (${info.units} unidades).`,
          })
        }
      }

      return {
        tenantId,
        periodStart: ps.toISOString(),
        periodEnd: pe.toISOString(),
        completedValidations: completedValidations.length,
        usageEvents: usageEvents.length,
        billableEvents: usageEvents.filter((e) => e.billable).length,
        divergences,
      }
    })
  }

  return {
    recordUsageEvent,
    recordUsageEventInTx,
    getConsumption,
    getQuota,
    getEvents,
    reconcile,
  }
}

export type UsageService = ReturnType<typeof makeUsageService>
