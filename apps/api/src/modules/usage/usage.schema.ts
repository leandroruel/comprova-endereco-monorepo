import { z } from 'zod'

/** Parâmetros de consulta de consumo por período. */
export const UsageConsumptionQuerySchema = z.object({
  periodStart: z.string().datetime().optional(),
  periodEnd: z.string().datetime().optional(),
})

export type UsageConsumptionQuery = z.infer<typeof UsageConsumptionQuerySchema>

/** Filtros para listagem de eventos de uso. */
export const UsageEventsQuerySchema = z.object({
  periodStart: z.string().datetime().optional(),
  periodEnd: z.string().datetime().optional(),
  billable: z.boolean().optional(),
  eventType: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
})

export type UsageEventsQuery = z.infer<typeof UsageEventsQuerySchema>

/** Resposta de consumo agregado. */
export const UsageConsumptionResponseSchema = z.object({
  tenantId: z.string().uuid(),
  periodStart: z.string(),
  periodEnd: z.string(),
  totalEvents: z.number().int(),
  totalUnits: z.number().int(),
  totalBillableUnits: z.number().int(),
  totalCostMicros: z.number().nullable(),
  byEventType: z.record(z.string(), z.number().int()),
})

export type UsageConsumptionResponse = z.infer<typeof UsageConsumptionResponseSchema>

/** Resposta de situação da cota. */
export const UsageQuotaResponseSchema = z.object({
  tenantId: z.string().uuid(),
  monthlyQuota: z.number().nullable(),
  consumedUnits: z.number().int(),
  remainingUnits: z.number().nullable(),
  hasHardLimit: z.boolean(),
  softThresholdPercent: z.number().nullable(),
  isSoftLimitReached: z.boolean(),
  isHardLimitReached: z.boolean(),
  periodStart: z.string(),
  periodEnd: z.string(),
})

export type UsageQuotaResponse = z.infer<typeof UsageQuotaResponseSchema>

/** Item de evento de uso na listagem. */
export const UsageEventItemSchema = z.object({
  eventId: z.string().uuid().nullable(),
  occurredAt: z.string(),
  eventType: z.string(),
  kind: z.string(),
  units: z.number().int(),
  costMicros: z.number().nullable(),
  validationId: z.string().uuid().nullable(),
  idempotencyKey: z.string().nullable(),
  billable: z.boolean(),
  source: z.string().nullable(),
})

export type UsageEventItem = z.infer<typeof UsageEventItemSchema>

/** Resposta de listagem de eventos. */
export const UsageEventsResponseSchema = z.object({
  events: z.array(UsageEventItemSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
})

export type UsageEventsResponse = z.infer<typeof UsageEventsResponseSchema>

/** Item de divergência na reconciliação. */
export const ReconciliationDivergenceSchema = z.object({
  type: z.enum([
    'validation_without_event',
    'duplicate_event',
    'event_without_validation',
    'unit_mismatch',
    'billability_mismatch',
  ]),
  validationId: z.string().uuid().nullable(),
  description: z.string(),
})

export type ReconciliationDivergence = z.infer<typeof ReconciliationDivergenceSchema>

/** Resposta de reconciliação. */
export const UsageReconciliationResponseSchema = z.object({
  tenantId: z.string().uuid(),
  periodStart: z.string(),
  periodEnd: z.string(),
  completedValidations: z.number().int(),
  usageEvents: z.number().int(),
  billableEvents: z.number().int(),
  divergences: z.array(ReconciliationDivergenceSchema),
})

export type UsageReconciliationResponse = z.infer<typeof UsageReconciliationResponseSchema>
