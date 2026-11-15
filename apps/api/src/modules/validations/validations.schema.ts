import {
  CreateValidationRequestSchema,
  ProblemSchema,
  ValidationsListDtoSchema,
  ValidationDtoSchema,
} from '@comprova/contracts'
import { SecuredVerifiableCredentialSchema } from '@comprova/credential'
import { z } from 'zod'

export const GetValidationParams = z.object({ id: z.uuid() })
export const NotModifiedResponse = z.null()
export const CreateValidationHeaders = z.object({
  'idempotency-key': z.string().min(8).max(128).optional(),
})
export const ContestValidationRequest = z.object({ reason: z.string().min(10).max(2000) })
export const ContestValidationResponse = z.object({
  contested: z.boolean(),
  validation_id: z.uuid(),
})

/**
 * Parâmetros de listagem de validações.
 *
 * `tenantId` faz parte do querystring para o fluxo de SESSÃO de usuário
 * (`requireSessionOrM2MVerify` lê `request.query.tenantId` e valida membership
 * em `organization_member`): precisa estar declarado no schema, pois o type
 * provider Zod substitui `request.query` pelo objeto parseado. Para M2M o
 * tenant vem da API key; `requireTenantMatch` exige que o query corresponda.
 */
export const ListValidationsQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
  limit: z
    .string()
    .optional()
    .transform((val) => (val === undefined ? 50 : Number(val)))
    .pipe(z.number().int().min(1).max(100)),
  offset: z
    .string()
    .optional()
    .transform((val) => (val === undefined ? 0 : Number(val)))
    .pipe(z.number().int().min(0)),
})

export type ListValidationsQuery = z.infer<typeof ListValidationsQuerySchema>

export const ValidationsListResponseSchema = ValidationsListDtoSchema

export { CreateValidationRequestSchema, ProblemSchema, ValidationsListDtoSchema, ValidationDtoSchema }
export { SecuredVerifiableCredentialSchema }
