import { pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tenant } from './tenancy.js'
import { verifierAuthUser } from './auth.js'

/**
 * Associação explícita usuário ↔ organização (tenant do tipo 'organization').
 * Um usuário pode pertencer a múltiplas organizações; uma organização pode
 * ter múltiplos membros. O usuário que cria a organização recebe 'owner'.
 *
 * A identidade canônica é `verifier_user.id` (tabela do dashboard do
 * Verifier), não a tabela legada `user` (Better Auth principal).
 */
export const organizationMember = pgTable(
  'organization_member',
  {
    organizationMemberId: uuid('organization_member_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    userId: text('user_id')
      .notNull()
      .references(() => verifierAuthUser.id),
    role: text('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    invitedBy: text('invited_by'),
  },
  (t) => [unique('organization_member_tenant_user_uq').on(t.tenantId, t.userId)],
)

/**
 * Convites de organização: email + token de uso único, expiração e aceite.
 * Usado no fluxo de onboarding: o administrador convida um membro por email;
 -- o token é resgatado no cadastro ou aceite do convite.
 */
export const organizationInvitation = pgTable(
  'organization_invitation',
  {
    organizationInvitationId: uuid('organization_invitation_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull(),
    role: text('role').notNull().default('member'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: text('accepted_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('organization_invitation_token_hash_uq').on(t.tokenHash)],
)

export type OrganizationMember = typeof organizationMember.$inferSelect
export type NewOrganizationMember = typeof organizationMember.$inferInsert
export type OrganizationInvitation = typeof organizationInvitation.$inferSelect
export type NewOrganizationInvitation = typeof organizationInvitation.$inferInsert
