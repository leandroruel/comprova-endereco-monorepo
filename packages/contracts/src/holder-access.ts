import { z } from 'zod'
import { HolderInformationRequestStateSchema } from './holder-information-request.js'

/**
 * F4.2 — visão do Holder sobre a própria solicitação.
 *
 * O Holder não tem conta: recebe um token opaco do Verifier e o apresenta em
 * `X-Holder-Token`. Esta visão nunca expõe `tenantId`, `holderId`, `createdBy`
 * ou dados de outros Holders.
 */
export const HolderAccessDocumentSchema = z.object({
  documentId: z.uuid(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  originalFilename: z.string(),
  createdAt: z.string(),
})

export type HolderAccessDocument = z.infer<typeof HolderAccessDocumentSchema>

export const HolderAccessItemSchema = z.object({
  itemId: z.string(),
  description: z.string(),
  required: z.boolean(),
  documentType: z.string().optional(),
  value: z.string().nullable(),
  documents: z.array(HolderAccessDocumentSchema),
})

export type HolderAccessItem = z.infer<typeof HolderAccessItemSchema>

export const HolderAccessRequestSchema = z.object({
  requestId: z.uuid(),
  type: z.string(),
  purpose: z.string(),
  state: HolderInformationRequestStateSchema,
  expiresAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  items: z.array(HolderAccessItemSchema),
})

export type HolderAccessRequest = z.infer<typeof HolderAccessRequestSchema>

/** Resposta textual de um item: sem JSON arbitrário, 1–5000 caracteres. */
export const SaveHolderItemResponseRequestSchema = z.object({
  value: z
    .string()
    .trim()
    .min(1, 'A resposta não pode ser vazia')
    .max(5000, 'A resposta deve ter no máximo 5000 caracteres'),
})

export type SaveHolderItemResponseRequest = z.infer<typeof SaveHolderItemResponseRequestSchema>

/** Token em claro só aparece nesta resposta de emissão, nunca é persistido. */
export const CreateHolderAccessTokenResponseSchema = z.object({
  tokenId: z.uuid(),
  token: z.string(),
  expiresAt: z.string(),
  createdAt: z.string(),
})

export type CreateHolderAccessTokenResponse = z.infer<typeof CreateHolderAccessTokenResponseSchema>

export const HolderAccessTokenIdParamsSchema = z.object({
  requestId: z.string().uuid(),
  tokenId: z.string().uuid(),
})
