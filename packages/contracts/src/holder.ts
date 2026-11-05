import { z } from 'zod'

export const DocumentTypeSchema = z.enum(['CPF', 'CNPJ'])
export type DocumentType = z.infer<typeof DocumentTypeSchema>

/**
 * documentHash armazena um HMAC-SHA-256 do CPF/CNPJ com um segredo protegido
 * compartilhado entre o Verifier e o serviço Comprova.
 *
 * SHA-256 simples é insuficiente para documentos com espaço de valores
 * previsível (CPF/CNPJ), pois permite ataque por enumeração. O HMAC-SHA-256
 * é calculado com um segredo derivado por tenant, de modo que o mesmo
 * CPF/CNPJ em tenants diferentes produza identificadores diferentes,
 * impedindo correlação global de titulares entre organizações.
 *
 * Contrato de integração (Verifier → Comprova):
 * - O Verifier calcula o HMAC-SHA-256 antes de enviar o documentHash à API.
 * - O segredo HMAC NUNCA é armazenado no banco de dados do Comprova.
 * - O segredo HMAC é derivado por tenant: `tenantSpecificSecret =
 *   HMAC(globalSecret, tenantId)`, onde `globalSecret` é provido via
 *   variável de ambiente do Verifier (ex.: HOLDER_DOCUMENT_HMAC_SECRET).
 * - O documentHash enviado à API já é o HMAC final com o segredo do tenant.
 * - O Comprova apenas valida o formato (64 caracteres hexadecimais) e armazena
 *   o valor recebido. Não recalcula, não compara com segredos próprios e não
 *   expõe segredos em logs, respostas ou auditoria.
 *
 * Rotação de segredos:
 * - Ao rotacionar o segredo global, todos os documentHash existentes
 *   deixam de ser reconhecíveis pelo novo segredo.
 * - Não há re-hash automático de registros existentes; a migração de
 *   registros antigos requer re-calculo do HMAC pelo Verifier com o novo
 *   segredo e atualização via PATCH /holders/:holderId.
 *
 * Não armazene CPF/CNPJ em texto puro. Não utilize um segredo global
 * compartilhado como chave direta para todos os tenants.
 */
export const CreateHolderRequestSchema = z.object({
  externalReference: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  documentHash: z.string().regex(/^[0-9a-f]{64}$/, {
    message: 'documentHash must be a HMAC-SHA-256 hex digest (64 lowercase hex characters)',
  }),
  documentType: DocumentTypeSchema.default('CPF'),
})

export type CreateHolderRequest = z.infer<typeof CreateHolderRequestSchema>

export const UpdateHolderRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  documentHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, {
      message: 'documentHash must be a HMAC-SHA-256 hex digest (64 lowercase hex characters)',
    })
    .optional(),
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
