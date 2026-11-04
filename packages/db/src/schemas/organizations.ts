import { pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { authUser } from './auth.js'
import { tenant } from './tenancy.js'

/**
 * Associação explícita usuário ↔ organização (tenant do tipo 'organization').
 * Um usuário pode pertencer a múltiplas organizações; uma organização pode
 * ter múltiplos membros. O usuário que cria a organização recebe 'owner'.
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
      .references(() => authUser.id),
    role: text('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    invitedBy: text('invited_by'),
  },
  (t) => [
    unique('organization_member_tenant_user_uq').on(t.tenantId, t.userId),
  ],
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
    token: text('token').notNull().unique(),
    role: text('role').notNull().default('member'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: text('accepted_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('organization_invitation_token_uq').on(t.token),
  ],
)

export type OrganizationMember = typeof organizationMember.$inferSelect
export type NewOrganizationMember = typeof organizationMember.$inferInsert
export type OrganizationInvitation = typeof organizationInvitation.$inferSelect
export type NewOrganizationInvitation = typeof organizationInvitation.$inferInsert
