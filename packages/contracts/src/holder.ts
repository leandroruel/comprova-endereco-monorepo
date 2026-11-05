import { z } from 'zod'

export const DocumentTypeSchema = z.enum(['CPF', 'CNPJ'])
export type DocumentType = z.infer<typeof DocumentTypeSchema>

export const CreateHolderRequestSchema = z.object({
  externalReference: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  documentHash: z.string().min(1).max(128),
  documentType: DocumentTypeSchema.default('CPF'),
})

export type CreateHolderRequest = z.infer<typeof CreateHolderRequestSchema>

export const UpdateHolderRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  documentHash: z.string().min(1).max(128).optional(),
  documentType: DocumentTypeSchema.optional(),
})

export type UpdateHolderRequest = z.infer<typeof UpdateHolderRequestSchema>

export const HolderDtoSchema = z.object({
  holderId: z.uuid(),
  tenantId: z.uuid(),
  externalReference: z.string(),
  name: z.string(),
  documentHash: z.string(),
  documentType: DocumentTypeSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type HolderDto = z.infer<typeof HolderDtoSchema>

export const ListHoldersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
})

export type ListHoldersQuery = z.infer<typeof ListHoldersQuerySchema>

export const ListHoldersResponseSchema = z.object({
  holders: z.array(HolderDtoSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
})

export type ListHoldersResponse = z.infer<typeof ListHoldersResponseSchema>
