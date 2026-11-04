import { z } from 'zod'

export const OrganizationTypeSchema = z.enum(['technical', 'organization'])
export const OrganizationOnboardingStatusSchema = z.enum([
  'pending',
  'completed',
  'suspended',
])
export const OrganizationMemberRoleSchema = z.enum(['owner', 'admin', 'member'])
export const ApiKeyTypeSchema = z.enum(['user', 'm2m'])

export const CreateOrganizationRequestSchema = z.object({
  name: z.string().min(1).max(200),
  legalName: z.string().min(1).max(200).optional(),
  document: z.string().min(1).max(20).optional(), // CPF/CNPJ sem máscara
  email: z.string().email(),
  termsVersion: z.string().min(1).max(100),
  dataRegion: z.string().min(1).max(10).default('sa-east-1'),
})

export type CreateOrganizationRequest = z.infer<typeof CreateOrganizationRequestSchema>

export const OrganizationDtoSchema = z.object({
  tenantId: z.uuid(),
  name: z.string(),
  legalName: z.string().nullable(),
  document: z.string().nullable(),
  type: z.string(),
  status: z.string(),
  onboardingStatus: z.string(),
  termsAcceptedAt: z.string().nullable(),
  termsAcceptedBy: z.string().nullable(),
  termsVersion: z.string().nullable(),
  dataRegion: z.string(),
  rateLimitRps: z.number(),
  burst: z.number(),
  monthlyQuota: z.number().nullable(),
  createdAt: z.string(),
})

export type OrganizationDto = z.infer<typeof OrganizationDtoSchema>

export const OrganizationMemberDtoSchema = z.object({
  organizationMemberId: z.uuid(),
  tenantId: z.uuid(),
  userId: z.string(),
  userEmail: z.string(),
  userName: z.string(),
  role: z.string(),
  joinedAt: z.string(),
  invitedBy: z.string().nullable(),
})

export type OrganizationMemberDto = z.infer<typeof OrganizationMemberDtoSchema>

export const CreateOrganizationMemberRequestSchema = z.object({
  email: z.string().email(),
  role: OrganizationMemberRoleSchema.default('member'),
})

export type CreateOrganizationMemberRequest = z.infer<
  typeof CreateOrganizationMemberRequestSchema
>

export const OrganizationInvitationDtoSchema = z.object({
  organizationInvitationId: z.uuid(),
  tenantId: z.uuid(),
  email: z.string(),
  role: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  createdAt: z.string(),
})

export type OrganizationInvitationDto = z.infer<typeof OrganizationInvitationDtoSchema>

export const CreateApiKeyRequestSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).default(['validate:read', 'validate:write']),
  keyType: ApiKeyTypeSchema.default('m2m'),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
})

export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequestSchema>

export const ApiKeyDtoSchema = z.object({
  apiKeyId: z.uuid(),
  tenantId: z.uuid(),
  keyPrefix: z.string(),
  key: z.string().optional(), // só retornado na criação
  scopes: z.array(z.string()),
  keyType: z.string(),
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
})

export type ApiKeyDto = z.infer<typeof ApiKeyDtoSchema>

