import { z } from 'zod'
import type { Db } from '@comprova/db'

export const CreateOrganizationBody = z.object({
  name: z.string().min(1).max(200),
  legalName: z.string().min(1).max(200).optional(),
  document: z.string().min(1).max(20).optional(),
  termsVersion: z.string().min(1).max(100),
  dataRegion: z.string().min(1).max(10).default('sa-east-1'),
})

export const CompleteOnboardingBody = z.object({
  termsVersion: z.string().min(1).max(100),
})

export const AddMemberBody = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'admin', 'member']).default('member'),
})

export const InviteMemberBody = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'admin', 'member']).default('member'),
  expiresInDays: z.number().int().min(1).max(3650).default(7),
})

export const AcceptInvitationBody = z.object({
  token: z.string().uuid(),
})

export const TenantIdParams = z.object({
  tenantId: z.string().uuid(),
})

export const OrganizationResponse = z.object({
  tenantId: z.string().uuid(),
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

export const OrganizationMemberResponse = z.object({
  organizationMemberId: z.string().uuid(),
  tenantId: z.string().uuid(),
  userId: z.string(),
  userEmail: z.string(),
  userName: z.string(),
  role: z.string(),
  joinedAt: z.string(),
  invitedBy: z.string().nullable(),
})

export const ProblemResponse = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  request_id: z.string().optional(),
})

/** Resposta de criação de convite: inclui o token apenas uma vez (na criação). */
export const OrganizationInvitationCreatedResponse = z.object({
  organizationInvitationId: z.uuid(),
  tenantId: z.string().uuid(),
  email: z.string(),
  role: z.string(),
  expiresAt: z.string(),
  createdAt: z.string(),
  /** O segredo do convite, retornado apenas uma vez na criação. */
  token: z.string(),
})

export type CreateOrganizationInput = z.infer<typeof CreateOrganizationBody>
export type CompleteOnboardingInput = z.infer<typeof CompleteOnboardingBody>
export type AddMemberInput = z.infer<typeof AddMemberBody>
export type InviteMemberInput = z.infer<typeof InviteMemberBody>
export type AcceptInvitationInput = z.infer<typeof AcceptInvitationBody>
export type TenantIdParamsInput = z.infer<typeof TenantIdParams>
export type OrganizationResponseType = z.infer<typeof OrganizationResponse>
export type OrganizationMemberResponseType = z.infer<typeof OrganizationMemberResponse>
export type OrganizationInvitationCreatedResponseType = z.infer<typeof OrganizationInvitationCreatedResponse>

export interface OrganizationsControllerDeps {
  readonly db: Db
}
