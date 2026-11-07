import { z } from 'zod'

/** Vocabulário estável de tipo de evento de uso (contrato canônico F3.3). */
export const UsageEventTypeSchema = z.enum(['technical_execution', 'processing_attempt', 'usage_event'])

export type UsageEventType = z.infer<typeof UsageEventTypeSchema>

/**
 * Evento de uso individual (leitura) — contrato canônico F3.3.
 *
 * Este schema é a ÚNICA definição do item de evento: a resposta HTTP da API
 * (`UsageEventItemSchema` em `apps/api/src/modules/usage/usage.schema.ts`)
 * reutiliza este schema para nunca divergir do contrato compartilhado.
 */
export const UsageEventDtoSchema = z.object({
  /** Identificador estável do evento (nulo em registros históricos). */
  eventId: z.uuid().nullable(),
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

/** Resposta de listagem de eventos de uso (paginação). */
export const UsageEventsDtoSchema = z.object({
  events: z.array(UsageEventDtoSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
})

export type UsageEventsDto = z.infer<typeof UsageEventsDtoSchema>

/** Agregado de consumo por tenant e período. */
export const UsageConsumptionDtoSchema = z.object({
  tenantId: z.uuid(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
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
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
})

export type UsageQuotaDto = z.infer<typeof UsageQuotaDtoSchema>

/** Resultado de reconciliação de uso. */
export const UsageReconciliationDtoSchema = z.object({
  tenantId: z.uuid(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
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
export const UsageConsumptionQuerySchema = z
  .object({
    periodStart: z.string().datetime().optional(),
    periodEnd: z.string().datetime().optional(),
  })
  .refine(
    (data) => {
      // Quando um dos bounds está ausente, usa o padrão (período corrente) e
      // não há janela inválida para rejeitar.
      if (!data.periodStart || !data.periodEnd) return true
      return new Date(data.periodEnd) >= new Date(data.periodStart)
    },
    {
      message: 'periodEnd não pode ser anterior a periodStart',
      path: ['periodEnd'],
    },
  )

export type UsageConsumptionQuery = z.infer<typeof UsageConsumptionQuerySchema>
