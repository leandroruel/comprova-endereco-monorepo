import { z } from 'zod'
import {
  UsageConsumptionDtoSchema,
  UsageConsumptionQuerySchema as SharedUsageConsumptionQuerySchema,
  UsageEventDtoSchema,
  UsageEventsDtoSchema,
  UsageQuotaDtoSchema,
  UsageReconciliationDtoSchema,
} from '@comprova/contracts'

/**
 * Parâmetros de consulta de consumo/reconciliação.
 *
 * `tenantId` faz parte do querystring para o fluxo de SESSÃO de usuário
 * (`requireSessionOrM2MVerify` lê `request.query.tenantId`). Ele precisa estar
 * DECLARADO no schema: o type provider Zod substitui `request.query` pelo
 * objeto parseado e `z.object` remove propriedades desconhecidas — sem a
 * declaração, o middleware receberia `undefined` mesmo com o parâmetro
 * presente. Para M2M o tenant é resolvido da API key autenticada; quando
 * `tenantId` vem no query, `requireTenantMatch` exige que corresponda.
 */
export const UsageConsumptionQuerySchema = SharedUsageConsumptionQuerySchema.extend({
  tenantId: z.string().uuid().optional(),
})

export type UsageConsumptionQuery = z.infer<typeof UsageConsumptionQuerySchema>

/** Converte uma string de query parameter em número inteiro de forma segura.
 *
 * Retorna `NaN` quando inválido, de modo que o `.pipe(z.number()...)` rejeite
 * com erro de validação (400) em vez de lançar exceção (500).
 */
const parseIntParam = (val: string | undefined, fallback: number): number => {
  if (val === undefined) return fallback
  const n = Number(val)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return NaN
  return n
}

/** Filtros para listagem de eventos de uso. */
export const UsageEventsQuerySchema = z.object({
  periodStart: z.string().datetime().optional(),
  periodEnd: z.string().datetime().optional(),
  // `tenantId` declarado pelo mesmo motivo do schema de consumo: o fluxo de
  // sessão precisa lê-lo de `request.query` (ver UsageConsumptionQuerySchema).
  tenantId: z.string().uuid().optional(),
  // `z.enum(['true','false'])` aceita apenas essas strings e as converte para
  // boolean. `z.coerce.boolean()` é EVITADO porque `Boolean("false")` é `true`.
  // O transform preserva `undefined`: sem ele, ausência do parâmetro viraria
  // `false` e o filtro de billable seria aplicado sempre.
  billable: z
    .enum(['true', 'false'] as const)
    .optional()
    .transform((val) => (val === undefined ? undefined : val === 'true')),
  eventType: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((val) => parseIntParam(val, 50))
    .pipe(z.number().int().min(1).max(100)),
  offset: z
    .string()
    .optional()
    .transform((val) => parseIntParam(val, 0))
    .pipe(z.number().int().min(0)),
})

export type UsageEventsQuery = z.infer<typeof UsageEventsQuerySchema>

/** Parâmetros de consulta da situação de cota (sessão precisa de `tenantId`). */
export const UsageQuotaQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
})

export type UsageQuotaQuery = z.infer<typeof UsageQuotaQuerySchema>

/** Resposta de consumo agregado — contrato compartilhado (`@comprova/contracts`). */
export const UsageConsumptionResponseSchema = UsageConsumptionDtoSchema

export type UsageConsumptionResponse = z.infer<typeof UsageConsumptionResponseSchema>

/** Resposta de situação da cota — contrato compartilhado (`@comprova/contracts`). */
export const UsageQuotaResponseSchema = UsageQuotaDtoSchema

/**
 * Item de evento de uso na listagem — contrato compartilhado
 * (`UsageEventDtoSchema` de `@comprova/contracts`), que inclui `eventId` e
 * `tenantId`. Reutilizado (não redefinido) para não divergir do contrato.
 */
export const UsageEventItemSchema = UsageEventDtoSchema

export type UsageEventItem = z.infer<typeof UsageEventItemSchema>

/** Resposta de listagem de eventos — contrato compartilhado (`@comprova/contracts`). */
export const UsageEventsResponseSchema = UsageEventsDtoSchema

export type UsageEventsResponse = z.infer<typeof UsageEventsResponseSchema>

/** Item de divergência na reconciliação — contrato compartilhado. */
export const ReconciliationDivergenceSchema = UsageReconciliationDtoSchema.shape.divergences.element

export type ReconciliationDivergence = z.infer<typeof ReconciliationDivergenceSchema>

/** Resposta de reconciliação — contrato compartilhado (`@comprova/contracts`). */
export const UsageReconciliationResponseSchema = UsageReconciliationDtoSchema

export type UsageReconciliationResponse = z.infer<typeof UsageReconciliationResponseSchema>
