import { z } from 'zod'

export const DocumentTypeSchema = z.enum(['CPF', 'CNPJ'])
export type DocumentType = z.infer<typeof DocumentTypeSchema>

/**
 * documentHash armazena um HMAC-SHA-256 do documento (CPF/CNPJ) com um
 * segredo protegido derivado por tenant, compartilhado entre o Verifier e
 * o serviço Comprova.
 *
 * SHA-256 simples é insuficiente para documentos com espaço de valores
 * previsível (CPF/CNPJ), pois permite ataque por enumeração. O HMAC-SHA-256
 * é calculado com um segredo derivado por tenant, de modo que o mesmo
 * documento em tenants diferentes produza identificadores diferentes,
 * impedindo correlação global de titulares entre organizações.
 *
 * Contrato de integração (Verifier → Comprova):
 *
 * 1. O Verifier é o único responsável por calcular o documentHash.
 *    O Comprova NÃO recebe o documento original (CPF/CNPJ em texto puro)
 *    e NÃO calcula o HMAC.
 *
 * 2. O Verifier normaliza o documento (ex.: remove máscara do CPF/CNPJ,
 *    converte para maiúsculas, remove espaços) antes de calcular o HMAC.
 *
 * 3. O segredo HMAC é derivado por tenant:
 *    tenantSpecificSecret = HMAC-SHA-256(globalSecret, tenantId)
 *    onde globalSecret é provido via variável de ambiente do Verifier
 *    (ex.: HOLDER_DOCUMENT_HMAC_SECRET).
 *
 * 4. O documentHash enviado à API já é o HMAC final:
 *    documentHash = HMAC-SHA-256(tenantSpecificSecret, documentoNormalizado)
 *    representado como string hexadecimal de 64 caracteres (lowercase).
 *
 * 5. O Comprova apenas valida o formato (z.string().regex(/^[0-9a-f]{64}$/))
 *    e armazena o valor recebido. Não recalcula, não compara com segredos
 *    próprios, não expõe segredos em logs, respostas ou auditoria.
 *
 * Rotação de segredos:
 * - Ao rotacionar o segredo global, todos os documentHash existentes
 *   deixam de ser reconhecíveis pelo novo segredo.
 * - Não há re-hash automático de registros existentes; a migração de
 *   registros antigos requer re-calculo do HMAC pelo Verifier com o novo
 *   segredo e atualização via PATCH /holders/:holderId.
 *
 * Não armazene CPF/CNPJ em texto puro. Não utilize um segredo global
 * compartilhado como chave direta para todos os tenants. O mesmo documento
 * em tenants diferentes deve produzir documentHash diferentes, pois o
 * segredo HMAC é específico de cada tenant.
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
