import { z } from 'zod'

/** Vocabulário estável de tipo de evento de uso (contrato canônico F3.3). */
export const UsageEventTypeSchema = z.enum(['technical_execution', 'processing_attempt', 'usage_event'])

export type UsageEventType = z.infer<typeof UsageEventTypeSchema>

/** Evento de uso individual (leitura). */
export const UsageEventDtoSchema = z.object({
  tenantId: z.uuid(),
  occurredAt: z.string(),
  eventType: UsageEventTypeSchema,
  kind: z.string(),
  units: z.number().int(),
  costMicros: z.number().nullable(),
  validationId: z.uuid().nullable(),
  idempotencyKey: z.string().nullable(),
  billable: z.boolean(),
  source: z.string().nullable(),
})

export type UsageEventDto = z.infer<typeof UsageEventDtoSchema>

/** Agregado de consumo por tenant e período. */
export const UsageConsumptionDtoSchema = z.object({
  tenantId: z.uuid(),
  periodStart: z.string(),
  periodEnd: z.string(),
  totalEvents: z.number().int(),
  totalUnits: z.number().int(),
  totalBillableUnits: z.number().int(),
  totalCostMicros: z.number().nullable(),
  byEventType: z.record(z.string(), z.number().int()),
})

export type UsageConsumptionDto = z.infer<typeof UsageConsumptionDtoSchema>

/** Situação da cota de um tenant. */
export const UsageQuotaDtoSchema = z.object({
  tenantId: z.uuid(),
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

export type UsageQuotaDto = z.infer<typeof UsageQuotaDtoSchema>

/** Resultado de reconciliação de uso. */
export const UsageReconciliationDtoSchema = z.object({
  tenantId: z.uuid(),
  periodStart: z.string(),
  periodEnd: z.string(),
  completedValidations: z.number().int(),
  usageEvents: z.number().int(),
  billableEvents: z.number().int(),
  divergences: z.array(
    z.object({
      type: z.enum([
        'validation_without_event',
        'duplicate_event',
        'event_without_validation',
        'unit_mismatch',
        'billability_mismatch',
      ]),
      validationId: z.uuid().nullable(),
      description: z.string(),
    }),
  ),
})

export type UsageReconciliationDto = z.infer<typeof UsageReconciliationDtoSchema>

/** Parâmetros de consulta de consumo. */
export const UsageConsumptionQuerySchema = z.object({
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
})

export type UsageConsumptionQuery = z.infer<typeof UsageConsumptionQuerySchema>
