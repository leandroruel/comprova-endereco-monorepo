import { and, eq, isNull } from '@comprova/db'
import * as t from '@comprova/db'
import { withTenant } from '@comprova/db'
import {
  type OrganizationDto,
  type OrganizationMemberDto,
  type OrganizationInvitationDto,
  type CreateOrganizationRequest,
  type CreateOrganizationMemberRequest,
} from '@comprova/contracts'
import { randomUUID } from 'node:crypto'

/**
 * Serviço de organizações Verifier.
 *
 * Opera sobre a raiz de tenancy (`tenant` do tipo 'organization') e as tabelas
 * `organization_member` / `organization_invitation`. Todo acesso é escopado
 * por RLS via `withTenant`, então o `tenantId` passado vem sempre do contexto
 * autenticado (nunca do cliente).
 */
export interface OrganizationsServiceDeps {
  readonly db: t.Db
}

export const makeOrganizationsService = (deps: OrganizationsServiceDeps) => {
  const { db } = deps

  /**
   * Cria uma organização Verifier e adiciona o usuário criador como 'owner'.
   * Requer que o usuário já exista na tabela `user` (Better Auth).
   */
  const createOrganization = async (
    create: CreateOrganizationRequest,
    userId: string,
  ): Promise<OrganizationDto> => {
    // Verifica se o usuário existe
    const user = await db
      .select({ id: t.authUser.id, email: t.authUser.email })
      .from(t.authUser)
      .where(eq(t.authUser.id, userId))
      .limit(1)
    if (user.length === 0) {
      throw new Error('user not found')
    }

    const tenantId = randomUUID()

    // Cria o tenant e a associação de propriedade dentro do escopo do tenant
    // (RLS exige app.tenant_id definido em ambas as tabelas).
    await withTenant(db, tenantId, async (tx) => {
      const insertedTenants = await tx
        .insert(t.tenant)
        .values({
          tenantId,
          name: create.name,
          type: 'organization',
          onboardingStatus: 'pending',
          termsVersion: create.termsVersion,
          dataRegion: create.dataRegion ?? 'sa-east-1',
        })
        .returning()

      const newTenant = insertedTenants[0]
      if (!newTenant) {
        throw new Error('failed to create organization')
      }

      // Adiciona o usuário como owner da organização
      await tx.insert(t.organizationMember).values({
        organizationMemberId: randomUUID(),
        tenantId,
        userId,
        role: 'owner',
      })
    })

    // Busca o tenant criado para retornar o DTO
    const [newTenant] = await db.select().from(t.tenant).where(eq(t.tenant.tenantId, tenantId)).limit(1)

    if (!newTenant) {
      throw new Error('failed to create organization')
    }

    return {
      tenantId: newTenant.tenantId,
      name: newTenant.name,
      legalName: null,
      document: null,
      type: newTenant.type,
      status: newTenant.status,
      onboardingStatus: newTenant.onboardingStatus,
      termsAcceptedAt: null,
      termsAcceptedBy: null,
      termsVersion: newTenant.termsVersion,
      dataRegion: newTenant.dataRegion,
      rateLimitRps: newTenant.rateLimitRps,
      burst: newTenant.burst,
      monthlyQuota: newTenant.monthlyQuota ?? null,
      createdAt: newTenant.createdAt.toISOString(),
    }
  }

  /**
   * Completa o onboarding: aceita termos e marca a organização como ativa.
   * Somente o owner da organização pode completar.
   */
  const completeOnboarding = async (
    tenantId: string,
    userId: string,
    termsVersion: string,
  ): Promise<OrganizationDto> => {
    // Verifica se o usuário é owner da organização
    const member = await db
      .select({ role: t.organizationMember.role })
      .from(t.organizationMember)
      .where(and(eq(t.organizationMember.tenantId, tenantId), eq(t.organizationMember.userId, userId)))
      .limit(1)

    if (member.length === 0) {
      throw new Error('only the organization owner can complete onboarding')
    }
    const memberRole = member[0]!.role
    if (memberRole !== 'owner') {
      throw new Error('only the organization owner can complete onboarding')
    }

    const [updated] = await db
      .update(t.tenant)
      .set({
        onboardingStatus: 'completed',
        termsAcceptedAt: new Date(),
        termsAcceptedBy: userId,
        termsVersion,
      })
      .where(eq(t.tenant.tenantId, tenantId))
      .returning()

    if (!updated) {
      throw new Error('organization not found')
    }

    return mapTenantToDto(updated)
  }

  /**
   * Lista organizações às quais o usuário pertence.
   */
  const listOrganizationsByUser = async (userId: string): Promise<OrganizationDto[]> => {
    const rows = await db
      .select({
        tenantId: t.tenant.tenantId,
        name: t.tenant.name,
        type: t.tenant.type,
        status: t.tenant.status,
        onboardingStatus: t.tenant.onboardingStatus,
        termsAcceptedAt: t.tenant.termsAcceptedAt,
        termsAcceptedBy: t.tenant.termsAcceptedBy,
        termsVersion: t.tenant.termsVersion,
        dataRegion: t.tenant.dataRegion,
        rateLimitRps: t.tenant.rateLimitRps,
        burst: t.tenant.burst,
        monthlyQuota: t.tenant.monthlyQuota,
        createdAt: t.tenant.createdAt,
      })
      .from(t.organizationMember)
      .innerJoin(t.tenant, eq(t.organizationMember.tenantId, t.tenant.tenantId))
      .where(eq(t.organizationMember.userId, userId))

    return rows.map(mapTenantRowToDto)
  }

  /**
   * Busca uma organização pelo ID. Retorna null se não existir ou se o
   * usuário não for membro.
   */
  const getOrganization = async (tenantId: string, userId: string): Promise<OrganizationDto | null> => {
    // Verifica membership
    const member = await db
      .select({ userId: t.organizationMember.userId })
      .from(t.organizationMember)
      .where(and(eq(t.organizationMember.tenantId, tenantId), eq(t.organizationMember.userId, userId)))
      .limit(1)

    if (member.length === 0) return null

    const [tenant] = await db.select().from(t.tenant).where(eq(t.tenant.tenantId, tenantId)).limit(1)

    if (!tenant) return null
    return mapTenantToDto(tenant)
  }

  /**
   * Adiciona um membro à organização (por email). O usuário convidado deve
   * já existir na tabela `user` (Better Auth).
   */
  const addMember = async (
    tenantId: string,
    create: CreateOrganizationMemberRequest,
    inviterUserId: string,
  ): Promise<OrganizationMemberDto> => {
    // Verifica se o convidante é owner ou admin
    const inviter = await db
      .select({ role: t.organizationMember.role })
      .from(t.organizationMember)
      .where(and(eq(t.organizationMember.tenantId, tenantId), eq(t.organizationMember.userId, inviterUserId)))
      .limit(1)

    if (inviter.length === 0) {
      throw new Error('only owners and admins can add members')
    }
    const inviterRole = inviter[0]!.role
    if (!['owner', 'admin'].includes(inviterRole)) {
      throw new Error('only owners and admins can add members')
    }

    // Busca o usuário por email
    const users = await db
      .select({ id: t.authUser.id, email: t.authUser.email, name: t.authUser.name })
      .from(t.authUser)
      .where(eq(t.authUser.email, create.email))
      .limit(1)

    const user = users[0]
    if (!user) {
      throw new Error('user not found')
    }

    // Verifica se já é membro
    const existing = await db
      .select({ userId: t.organizationMember.userId })
      .from(t.organizationMember)
      .where(and(eq(t.organizationMember.tenantId, tenantId), eq(t.organizationMember.userId, user.id)))
      .limit(1)

    if (existing.length > 0) {
      throw new Error('user is already a member')
    }

    const insertedMembers = await db
      .insert(t.organizationMember)
      .values({
        organizationMemberId: randomUUID(),
        tenantId,
        userId: user.id,
        role: create.role,
        invitedBy: inviterUserId,
      })
      .returning()

    const member = insertedMembers[0]
    if (!member) {
      throw new Error('failed to create membership')
    }

    return {
      organizationMemberId: member.organizationMemberId,
      tenantId: member.tenantId,
      userId: member.userId,
      userEmail: user.email,
      userName: user.name,
      role: member.role,
      joinedAt: member.joinedAt.toISOString(),
      invitedBy: member.invitedBy ?? null,
    }
  }

  /**
   * Lista membros de uma organização (somente membros da organização).
   */
  const listMembers = async (tenantId: string, userId: string): Promise<OrganizationMemberDto[]> => {
    // Verifica membership
    const member = await db
      .select({ userId: t.organizationMember.userId })
      .from(t.organizationMember)
      .where(and(eq(t.organizationMember.tenantId, tenantId), eq(t.organizationMember.userId, userId)))
      .limit(1)

    if (member.length === 0) return []

    const rows = await db
      .select({
        organizationMemberId: t.organizationMember.organizationMemberId,
        tenantId: t.organizationMember.tenantId,
        userId: t.organizationMember.userId,
        userEmail: t.authUser.email,
        userName: t.authUser.name,
        role: t.organizationMember.role,
        joinedAt: t.organizationMember.joinedAt,
        invitedBy: t.organizationMember.invitedBy,
      })
      .from(t.organizationMember)
      .innerJoin(t.authUser, eq(t.organizationMember.userId, t.authUser.id))
      .where(eq(t.organizationMember.tenantId, tenantId))

    return rows.map((row) => ({
      organizationMemberId: row.organizationMemberId,
      tenantId: row.tenantId,
      userId: row.userId,
      userEmail: row.userEmail,
      userName: row.userName,
      role: row.role,
      joinedAt: row.joinedAt.toISOString(),
      invitedBy: row.invitedBy ?? null,
    }))
  }

  /**
   * Cria um convite para um email (token de uso único). O email não precisa
   * existir como usuário ainda.
   */
  const createInvitation = async (
    tenantId: string,
    email: string,
    role: 'owner' | 'admin' | 'member',
    inviterUserId: string,
    expiresInDays: number,
  ): Promise<OrganizationInvitationDto> => {
    // Verifica se o convidante é owner ou admin
    const inviter = await db
      .select({ role: t.organizationMember.role })
      .from(t.organizationMember)
      .where(and(eq(t.organizationMember.tenantId, tenantId), eq(t.organizationMember.userId, inviterUserId)))
      .limit(1)

    if (inviter.length === 0) {
      throw new Error('only owners and admins can create invitations')
    }
    const inviterRole = inviter[0]!.role
    if (!['owner', 'admin'].includes(inviterRole)) {
      throw new Error('only owners and admins can create invitations')
    }

    const token = randomUUID()
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)

    const [invitation] = await db
      .insert(t.organizationInvitation)
      .values({
        organizationInvitationId: randomUUID(),
        tenantId,
        email,
        token,
        role,
        expiresAt,
      })
      .returning()

    if (!invitation) {
      throw new Error('invitation not found')
    }

    return {
      organizationInvitationId: invitation.organizationInvitationId,
      tenantId: invitation.tenantId,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
      acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
      createdAt: invitation.createdAt.toISOString(),
    }
  }

  /**
   * Aceita um convite: adiciona o usuário como membro da organização.
   * O token é consumido (marcado como aceito).
   */
  const acceptInvitation = async (token: string, userId: string): Promise<OrganizationMemberDto> => {
    const [invitation] = await db
      .select()
      .from(t.organizationInvitation)
      .where(and(eq(t.organizationInvitation.token, token), isNull(t.organizationInvitation.acceptedAt)))
      .limit(1)

    if (!invitation) {
      throw new Error('invitation not found or already accepted')
    }

    if (invitation.expiresAt < new Date()) {
      throw new Error('invitation expired')
    }

    // Verifica se o usuário já é membro
    const existing = await db
      .select({ userId: t.organizationMember.userId })
      .from(t.organizationMember)
      .where(
        and(eq(t.organizationMember.tenantId, invitation.tenantId), eq(t.organizationMember.userId, userId)),
      )
      .limit(1)

    if (existing.length > 0) {
      throw new Error('user is already a member')
    }

    // Marca o convite como aceito e adiciona o membro em uma única transação
    const result = await db.transaction(async (tx) => {
      const claimed = await tx
        .update(t.organizationInvitation)
        .set({ acceptedAt: new Date(), acceptedBy: userId })
        .where(
          and(
            eq(t.organizationInvitation.organizationInvitationId, invitation.organizationInvitationId),
            isNull(t.organizationInvitation.acceptedAt),
          ),
        )
        .returning()

      if (claimed.length === 0) {
        throw new Error('invitation not found or already accepted')
      }

      // Adiciona o usuário como membro
      const insertedMembers = await tx
        .insert(t.organizationMember)
        .values({
          organizationMemberId: randomUUID(),
          tenantId: invitation.tenantId,
          userId,
          role: invitation.role,
          invitedBy: null,
        })
        .returning()

      return insertedMembers[0]
    })

    const member = result
    if (!member) {
      throw new Error('failed to create membership')
    }

    return {
      organizationMemberId: member.organizationMemberId,
      tenantId: member.tenantId,
      userId: member.userId,
      userEmail: invitation.email,
      userName: '',
      role: member.role,
      joinedAt: member.joinedAt.toISOString(),
      invitedBy: member.invitedBy ?? null,
    }
  }

  return {
    createOrganization,
    completeOnboarding,
    listOrganizationsByUser,
    getOrganization,
    addMember,
    listMembers,
    createInvitation,
    acceptInvitation,
  }
}

function mapTenantToDto(tenant: {
  tenantId: string
  name: string
  type: string
  status: string
  onboardingStatus: string
  termsAcceptedAt: Date | null
  termsAcceptedBy: string | null
  termsVersion: string | null
  dataRegion: string
  rateLimitRps: number
  burst: number
  monthlyQuota: bigint | number | null
  createdAt: Date
}): OrganizationDto {
  return {
    tenantId: tenant.tenantId,
    name: tenant.name,
    legalName: null,
    document: null,
    type: tenant.type,
    status: tenant.status,
    onboardingStatus: tenant.onboardingStatus,
    termsAcceptedAt: tenant.termsAcceptedAt?.toISOString() ?? null,
    termsAcceptedBy: tenant.termsAcceptedBy,
    termsVersion: tenant.termsVersion,
    dataRegion: tenant.dataRegion,
    rateLimitRps: tenant.rateLimitRps,
    burst: tenant.burst,
    monthlyQuota: tenant.monthlyQuota !== null ? Number(tenant.monthlyQuota) : null,
    createdAt: tenant.createdAt.toISOString(),
  }
}

function mapTenantRowToDto(row: {
  tenantId: string
  name: string
  type: string
  status: string
  onboardingStatus: string
  termsAcceptedAt: Date | null
  termsAcceptedBy: string | null
  termsVersion: string | null
  dataRegion: string
  rateLimitRps: number
  burst: number
  monthlyQuota: bigint | number | null
  createdAt: Date
}): OrganizationDto {
  return mapTenantToDto(row)
}
