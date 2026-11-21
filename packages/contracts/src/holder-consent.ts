import { z } from 'zod'

/**
 * F4.1 — consentimento do Holder.
 *
 * O registro de consentimento permite identificar a solicitação, a versão
 * dos termos apresentados, a data/hora do aceite (relógio do banco), o
 * estado e o evento de auditoria correspondente. O texto dos termos é de
 * responsabilidade do produto (pendente de conteúdo aprovado).
 */

/**
 * Versão vigente dos termos, definida exclusivamente pelo servidor.
 *
 * O Holder não escolhe a versão: ele deve aceitar exatamente a versão
 * apresentada aqui. `approved` é `false` enquanto o conteúdo jurídico não
 * estiver formalmente aprovado, e nesse caso o aceite é bloqueado.
 * `content` contém o texto integral dos termos aprovados e só deve ser
 * apresentado quando houver conteúdo aprovado disponível.
 */
export const HolderTermsSchema = z.object({
  version: z.string().nullable(),
  approved: z.boolean(),
  documentHash: z.string().nullable(),
  content: z.string().nullable(),
})

export type HolderTerms = z.infer<typeof HolderTermsSchema>

/**
 * Requisição de registro de consentimento (pública, com X-Holder-Token).
 *
 * `termsVersion` é a versão efetivamente apresentada ao Holder. O servidor
 * compara com a versão vigente e rejeita divergências; a versão persistida é
 * sempre a do servidor.
 */
export const HolderConsentRequestSchema = z.object({
  termsVersion: z.string().min(1).max(100),
})

export type HolderConsentRequest = z.infer<typeof HolderConsentRequestSchema>

/** Resposta do registro de consentimento (mesma forma do status na visão). */
export const HolderConsentResponseSchema = z.object({
  granted: z.boolean(),
  termsVersion: z.string().nullable(),
  acceptedAt: z.string().nullable(),
})

export type HolderConsentResponse = z.infer<typeof HolderConsentResponseSchema>

/** Status de consentimento incluído na visão do Holder. */
export const HolderConsentStatusSchema = HolderConsentResponseSchema

export type HolderConsentStatus = z.infer<typeof HolderConsentStatusSchema>
