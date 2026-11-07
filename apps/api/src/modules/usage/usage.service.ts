import {
  and,
  desc,
  eq,
  inArray,
  sql,
  withTenant,
  type Db,
  SOFT_THRESHOLD_PERCENT,
  defaultPeriod,
  recordUsageEventInTx,
  type UsageEventRecorded,
} from '@comprova/db'
import * as t from '@comprova/db'
import type { UsageEventType } from '@comprova/contracts'
import type { UsageConsumptionQuery, UsageEventsQuery } from './usage.schema.js'

const parseDate = (value: string | undefined): Date | undefined => {
  if (!value) return undefined
  const d = new Date(value)
  return isNaN(d.getTime()) ? undefined : d
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
            sql`usage_event.occurred_at >= ${periodStart.toISOString()}`,
            sql`usage_event.occurred_at < ${periodEnd.toISOString()}`,
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

      const hasHardLimit = monthlyQuota !== null
      const remainingUnits = hasHardLimit ? Math.max(0, monthlyQuota - consumedUnits) : null
      const softThreshold = hasHardLimit ? Math.floor((monthlyQuota * SOFT_THRESHOLD_PERCENT) / 100) : null
      const isSoftLimitReached =
        hasHardLimit &&
        softThreshold !== null &&
        consumedUnits >= softThreshold &&
        consumedUnits < monthlyQuota
      const isHardLimitReached = hasHardLimit && consumedUnits >= monthlyQuota

      return {
        tenantId,
        monthlyQuota,
        consumedUnits,
        remainingUnits,
        hasHardLimit,
        // Percentual constante (80%) — é o limiar configurado, não o valor
        // convertido em unidades.
        softThresholdPercent: hasHardLimit ? SOFT_THRESHOLD_PERCENT : null,
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
      readonly tenantId: string
      readonly occurredAt: string
      readonly eventType: UsageEventType
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
        sql`usage_event.occurred_at >= ${periodStart.toISOString()}`,
        sql`usage_event.occurred_at < ${periodEnd.toISOString()}`,
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
          tenantId: t.usageEvent.tenantId,
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
          .where(and(...conditions)),
      ])

      const total = Number(totalRow[0]?.total ?? 0)

      return {
        events: rows.map((row) => ({
          eventId: row.eventId ?? null,
          tenantId: row.tenantId,
          occurredAt: row.occurredAt.toISOString(),
          eventType: row.eventType as UsageEventType,
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
      // Validações concluídas no período, selecionadas pelo tempo de
      // conclusão (`completed_at`), não pelo `created_at`. Apenas validações
      // que efetivamente atingiram estado terminal dentro do período entram na
      // base de comparação (CodeRabbit g).
      const completedValidations = await tx
        .select({
          id: t.validation.validationId,
          status: t.validation.status,
          completedAt: t.validation.completedAt,
          units: sql<number>`1`,
        })
        .from(t.validation)
        .where(
          and(
            eq(t.validation.tenantId, tenantId),
            eq(t.validation.status, 'completed'),
            sql`validation.completed_at >= ${ps.toISOString()}`,
            sql`validation.completed_at < ${pe.toISOString()}`,
          ),
        )

      // Eventos de uso no período (todos os tipos, faturáveis ou não).
      const usageEvents = await tx
        .select({
          id: t.usageEvent.idempotencyKey,
          validationId: t.usageEvent.validationId,
          billable: t.usageEvent.billable,
          units: t.usageEvent.units,
          eventType: t.usageEvent.eventType,
        })
        .from(t.usageEvent)
        .where(
          and(
            eq(t.usageEvent.tenantId, tenantId),
            sql`usage_event.occurred_at >= ${ps.toISOString()}`,
            sql`usage_event.occurred_at < ${pe.toISOString()}`,
          ),
        )

      const completedIds = new Set(completedValidations.map((v) => v.id))

      // Validações concluídas cujo resultado decorre de INDISPONIBILIDADE de
      // fonte externa (timeout de checker, fonte indisponível, falha interna —
      // mesmos critérios de `hasExternalUnavailability`): pela política
      // provisória do ADR-0044 §3 elas NÃO são faturáveis, portanto não são
      // divergência de faturamento. Isso não "perdoa" qualquer evento não
      // faturável: apenas conclusões com evidência de indisponibilidade são
      // isentas, e a isenção é auditável pelos sinais persistidos.
      const unavailableValidationIds = new Set<string>()
      if (completedValidations.length > 0) {
        const unavailableRows = await tx
          .selectDistinct({ validationId: t.signal.validationId })
          .from(t.signal)
          .where(
            and(
              inArray(
                t.signal.validationId,
                completedValidations.map((v) => v.id),
              ),
              sql`(signal.source LIKE '%:timeout' OR signal.detail->>'reason' IN ('checker_timeout', 'source_unavailable', 'internal_error'))`,
            ),
          )
        for (const row of unavailableRows) {
          unavailableValidationIds.add(row.validationId)
        }
      }

      // Agrupa eventos por validationId (ignorando validationId nulo).
      const eventsByValidation = new Map<
        string,
        { billable: { count: number; units: number }[]; any: number }
      >()
      let eventsWithoutValidationId = 0

      for (const e of usageEvents) {
        if (e.validationId === null) {
          eventsWithoutValidationId += 1
          continue
        }
        let entry = eventsByValidation.get(e.validationId)
        if (!entry) {
          entry = { billable: [], any: 0 }
          eventsByValidation.set(e.validationId, entry)
        }
        entry.any += 1
        if (e.billable) {
          entry.billable.push({ count: 1, units: Number(e.units) })
        }
      }

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

      // --- Regras de comparação (somente leitura, não corrige silenciosamente) ---

      // 1. Validação concluída sem evento faturável (validation_without_event)
      //    ou com evento apenas não-faturável (billability_mismatch).
      //    Um evento não faturável não é evidência suficiente de que a validação
      //    concluída foi corretamente faturada — EXCETO quando a conclusão
      //    decorre de indisponibilidade de fonte externa (política ADR-0044 §3).
      for (const v of completedValidations) {
        if (unavailableValidationIds.has(v.id)) continue

        const entry = eventsByValidation.get(v.id)
        const billableEvents = entry?.billable ?? []

        if (billableEvents.length === 0) {
          if (entry === undefined || entry.any === 0) {
            // Nenhum evento de uso associado.
            divergences.push({
              type: 'validation_without_event',
              validationId: v.id,
              description: `Validação concluída ${v.id} não possui evento de uso faturável associado.`,
            })
          } else {
            // Possui evento(s), mas nenhum é faturável → divergência de
            // faturabilidade: a validação concluiu mas não foi cobrada.
            divergences.push({
              type: 'billability_mismatch',
              validationId: v.id,
              description: `Validação concluída ${v.id} possui ${entry.any} evento(s) de uso, nenhum faturável.`,
            })
          }
          continue
        }

        // 2. Mais de um evento faturável para a mesma validação (duplicate_event).
        if (billableEvents.length > 1) {
          const totalUnits = billableEvents.reduce((sum, b) => sum + b.units, 0)
          divergences.push({
            type: 'duplicate_event',
            validationId: v.id,
            description: `Validação ${v.id} possui ${billableEvents.length} eventos faturáveis (${totalUnits} unidades); esperado no máximo 1.`,
          })
          continue
        }

        // 3. Exatamente 1 evento faturável: comparar unidades (unit_mismatch).
        //    Esperado: 1 unidade por validação concluída.
        const registeredUnits = billableEvents[0]!.units
        if (registeredUnits !== 1) {
          divergences.push({
            type: 'unit_mismatch',
            validationId: v.id,
            description: `Validação ${v.id} registrou ${registeredUnits} unidade(s) faturável(es); esperado 1.`,
          })
        }
      }

      // 4. Eventos sem validação correspondente (event_without_validation):
      //    - validationId nulo
      //    - validationId que não corresponde a uma validação concluída no período
      if (eventsWithoutValidationId > 0) {
        divergences.push({
          type: 'event_without_validation',
          validationId: null,
          description: `${eventsWithoutValidationId} evento(s) de uso sem validationId (não associado a nenhuma validação).`,
        })
      }

      for (const [validationId, entry] of eventsByValidation) {
        if (!completedIds.has(validationId)) {
          divergences.push({
            type: 'event_without_validation',
            validationId,
            description: `${entry.any} evento(s) de uso referencia(m) validação ${validationId} não concluída no período.`,
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
