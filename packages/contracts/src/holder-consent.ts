import { z } from 'zod'

/**
 * F4.1 — consentimento do Holder.
 *
 * O registro de consentimento permite identificar a solicitação, a versão
 * dos termos apresentados, a data/hora do aceite (relógio do banco), o
 * estado e o evento de auditoria correspondente. O texto dos termos é de
 * responsabilidade do produto (pendente de conteúdo aprovado).
 */

/** Requisição de registro de consentimento (pública, com X-Holder-Token). */
export const HolderConsentRequestSchema = z.object({
  termsVersion: z.string().min(1).max(100),
})

export type HolderConsentRequest = z.infer<typeof HolderConsentRequestSchema>

/** Resposta do registro de consentimento. */
export const HolderConsentResponseSchema = z.object({
  consentId: z.uuid(),
  holderInformationRequestId: z.uuid(),
  termsVersion: z.string(),
  state: z.enum(['granted', 'withdrawn']),
  acceptedAt: z.string(),
})

export type HolderConsentResponse = z.infer<typeof HolderConsentResponseSchema>

/** Status de consentimento incluído na visão do Holder. */
export const HolderConsentStatusSchema = z.object({
  granted: z.boolean(),
  termsVersion: z.string().nullable(),
  acceptedAt: z.string().nullable(),
})

export type HolderConsentStatus = z.infer<typeof HolderConsentStatusSchema>
