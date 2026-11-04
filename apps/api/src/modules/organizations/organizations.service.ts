import { and, eq, isNull, sql, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import {
  type OrganizationDto,
  type OrganizationMemberDto,
  type OrganizationInvitationCreatedDto,
  type CreateOrganizationRequest,
  type CreateOrganizationMemberRequest,
} from '@comprova/contracts'
import { randomUUID } from 'node:crypto'
import { createHmac } from 'node:crypto'

/**
 * Serviço de organizações Verifier.
 *
 * Opera sobre a raiz de tenancy (`tenant` do tipo 'organization') e as tabelas
 * `organization_member` / `organization_invitation`.
 *
 * Operações single-tenant executam dentro de `withTenant()`, que define
 * `app.tenant_id` para que as políticas RLS isolem os dados por organização.
 * Operações que são inerentemente multi-tenant (listar organizações de um
 * usuário e resgatar um convite pelo token) definem `app.user_id` /
 * `app.user_email` dentro de uma transação, permitindo que as políticas RLS
 * liberem somente as linhas próprias do usuário autenticado. O `tenantId` nunca
 * vem do cliente.
 */
export interface OrganizationsServiceDeps {
  readonly db: t.Db
}

/**
 * HMAC-SHA256 do token de convite, usando o mesmo pepper das API keys.
 */
const INVITE_TOKEN_PEPPER = 'invite-token-pepper'

const hashInviteToken = (token: string): string => {
  return createHmac('sha256', INVITE_TOKEN_PEPPER).update(token).digest('hex')
}

/**
 * Normaliza um e-mail para comparação case-insensitive.
 */
const normalizeEmail = (email: string): string => {
  return email.trim().toLowerCase()
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
          legalName: create.legalName ?? null,
          document: create.document ?? null,
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
      legalName: newTenant.legalName,
      document: newTenant.document,
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
      role: 'owner',
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
    // Verifica se o usuário é owner da organização dentro do escopo do tenant
    const member = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select({ role: t.organizationMember.role })
        .from(t.organizationMember)
        .where(and(eq(t.organizationMember.tenantId, tenantId), eq(t.organizationMember.userId, userId)))
        .limit(1)
    })

    if (member.length === 0) {
      throw new Error('only the organization owner can complete onboarding')
    }
    const memberRole = member[0]!.role
    if (memberRole !== 'owner') {
      throw new Error('only the organization owner can complete onboarding')
    }

    const [updated] = await withTenant(db, tenantId, async (tx) => {
      return tx
        .update(t.tenant)
        .set({
          onboardingStatus: 'completed',
          termsAcceptedAt: new Date(),
          termsAcceptedBy: userId,
          termsVersion,
        })
        .where(eq(t.tenant.tenantId, tenantId))
        .returning()
    })

    if (!updated) {
      throw new Error('organization not found')
    }

    return mapTenantToDto(updated)
  }

  /**
   * Lista organizações às quais o usuário pertence.
   *
   * Consulta é inerentemente multi-tenant (um usuário pode pertencer a vários
   * tenants), então não há um único `app.tenant_id` para usar. Define
   * `app.user_id` dentro de uma transação para que a política RLS de
   * `organization_member` libere somente as associações próprias do usuário,
   * sem vazar dados de outras organizações.
   */
  const listOrganizationsByUser = async (userId: string): Promise<OrganizationDto[]> => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`)
      return tx
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
          role: t.organizationMember.role,
        })
        .from(t.organizationMember)
        .innerJoin(t.tenant, eq(t.organizationMember.tenantId, t.tenant.tenantId))
        .where(eq(t.organizationMember.userId, userId))
        .orderBy(t.tenant.createdAt)
    })

    return rows.map(mapTenantRowToDto)
  }

  /**
   * Busca uma organização pelo ID. Retorna null se não existir ou se o
   * usuário não for membro.
   */
  const getOrganization = async (tenantId: string, userId: string): Promise<OrganizationDto | null> => {
    // Verifica membership
    const member = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select({ userId: t.organizationMember.userId })
        .from(t.organizationMember)
        .where(and(eq(t.organizationMember.tenantId, tenantId), eq(t.organizationMember.userId, userId)))
        .limit(1)
    })

    if (member.length === 0) return null

    const [tenant] = await withTenant(db, tenantId, async (tx) => {
      return tx.select().from(t.tenant).where(eq(t.tenant.tenantId, tenantId)).limit(1)
    })

    if (!tenant) return null
    return mapTenantToDto(tenant)
  }

  /**
   * Adiciona um membro à organização (por email). O usuário convidado deve
   * já existir na tabela `user` (Better Auth).
   *
   * Apenas owner pode conceder role 'owner'. Admin pode conceder 'admin' ou 'member'.
   * Não é permitido criar múltiplos owners.
   */
  const addMember = async (
    tenantId: string,
    create: CreateOrganizationMemberRequest,
    inviterUserId: string,
  ): Promise<OrganizationMemberDto> => {
    // Verifica se o convidante é owner ou admin dentro do escopo do tenant
    const inviter = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select({ role: t.organizationMember.role })
        .from(t.organizationMember)
        .where(
          and(eq(t.organizationMember.tenantId, tenantId), eq(t.organizationMember.userId, inviterUserId)),
        )
        .limit(1)
    })

    if (inviter.length === 0) {
      throw new Error('only owners and admins can add members')
    }
    const inviterRole = inviter[0]!.role

    // Só o owner pode conceder papel de owner. Admin concede, no máximo,
    // 'admin' ou 'member'.
    if (create.role === 'owner' && inviterRole !== 'owner') {
      throw new Error('only the owner can grant the owner role')
    }

    // Modelo de proprietário único: evita múltiplos owners. O papel 'owner'
    // só pode ser concedido quando a organização ainda não tem um
    // proprietário. Transferência de propriedade requer um endpoint dedicado
    // (fora do escopo desta fase).
    if (create.role === 'owner') {
      const owners = await withTenant(db, tenantId, async (tx) => {
        return tx
          .select({ userId: t.organizationMember.userId })
          .from(t.organizationMember)
          .where(and(eq(t.organizationMember.tenantId, tenantId), eq(t.organizationMember.role, 'owner')))
      })
      if (owners.length > 0) {
        throw new Error('a organização já possui um proprietário')
      }
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

    // Verifica se já é membro dentro do escopo do tenant
    const existing = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select({ userId: t.organizationMember.userId })
        .from(t.organizationMember)
        .where(and(eq(t.organizationMember.tenantId, tenantId), eq(t.organizationMember.userId, user.id)))
        .limit(1)
    })

    if (existing.length > 0) {
      throw new Error('user is already a member')
    }

    const insertedMembers = await withTenant(db, tenantId, async (tx) => {
      return tx
        .insert(t.organizationMember)
        .values({
          organizationMemberId: randomUUID(),
          tenantId,
          userId: user.id,
          role: create.role,
          invitedBy: inviterUserId,
        })
        .returning()
    })

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
    const member = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select({ userId: t.organizationMember.userId })
        .from(t.organizationMember)
        .where(and(eq(t.organizationMember.tenantId, tenantId), eq(t.organizationMember.userId, userId)))
        .limit(1)
    })

    if (member.length === 0) return []

    const rows = await withTenant(db, tenantId, async (tx) => {
      return tx
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
    })

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
   *
   * Apenas owner pode criar convite com role 'owner'. Admin só pode criar
   * com 'admin' ou 'member'.
   */
  const createInvitation = async (
    tenantId: string,
    email: string,
    role: 'owner' | 'admin' | 'member',
    inviterUserId: string,
    expiresInDays: number,
  ): Promise<OrganizationInvitationCreatedDto> => {
    // TODO: verificação
    // Verifica se o convidante é owner ou admin
    const inviter = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select({ role: t.organizationMember.role })
        .from(t.organizationMember)
        .where(
          and(eq(t.organizationMember.tenantId, tenantId), eq(t.organizationMember.userId, inviterUserId)),
        )
        .limit(1)
    })

    if (inviter.length === 0) {
      throw new Error('only owners and admins can create invitations')
    }
    const inviterRole = inviter[0]!.role

    // Só o owner pode criar convite com role 'owner'. Admin só pode criar
    // com 'admin' ou 'member'.
    if (role === 'owner' && inviterRole !== 'owner') {
      throw new Error('only the owner can grant the owner role')
    }

    // Modelo de proprietário único: evita múltiplos owners via convite.
    if (role === 'owner') {
      const owners = await withTenant(db, tenantId, async (tx) => {
        return tx
          .select({ userId: t.organizationMember.userId })
          .from(t.organizationMember)
          .where(and(eq(t.organizationMember.tenantId, tenantId), eq(t.organizationMember.role, 'owner')))
      })
      if (owners.length > 0) {
        throw new Error('a organização já possui um proprietário')
      }
    }

    const token = randomUUID()
    const tokenHash = hashInviteToken(token)
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)

    const [invitation] = await withTenant(db, tenantId, async (tx) => {
      return tx
        .insert(t.organizationInvitation)
        .values({
          organizationInvitationId: randomUUID(),
          tenantId,
          email,
          tokenHash,
          role,
          expiresAt,
        })
        .returning()
    })

    if (!invitation) {
      throw new Error('invitation not found')
    }

    return {
      organizationInvitationId: invitation.organizationInvitationId,
      tenantId: invitation.tenantId,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
      createdAt: invitation.createdAt.toISOString(),
      // O token é retornado apenas uma vez (na criação), para ser enviado ao
      // destinatário por um canal externo. Nunca é exposto novamente.
      token,
    }
  }

  /**
   * Aceita um convite: adiciona o usuário como membro da organização.
   * O token é consumido (marcado como aceito) de forma atômica.
   *
   * Verifica que o e-mail da conta autenticada corresponde ao e-mail do
   * convite, impedindo que outra pessoa resgate um convite alheio.
   *
   * A leitura do convite pelo token é inerentemente multi-tenant (o tenant
   * só é conhecido após encontrar o convite), então define `app.user_email`
   * em uma transação para que a política RLS libere somente convites
   * endereçados ao usuário autenticado. O consumo (marcar como aceito +
   * criar associação) ocorre dentro de `withTenant()` do tenant do convite,
   * com `WHERE acceptedAt IS NULL`, garantindo uso único mesmo sob
   * requisições concorrentes.
   */
  const acceptInvitation = async (token: string, userId: string): Promise<OrganizationMemberDto> => {
    // Busca o usuário autenticado para obter seu e-mail e nome.
    // A tabela `user` não tem RLS, então a consulta é direta.
    const users = await db
      .select({ id: t.authUser.id, email: t.authUser.email, name: t.authUser.name })
      .from(t.authUser)
      .where(eq(t.authUser.id, userId))
      .limit(1)

    if (users.length === 0) {
      throw new Error('user not found')
    }

    const authenticatedUser = users[0]!
    const authenticatedEmail = normalizeEmail(authenticatedUser.email)

    // Localiza o convite pelo hash do token sem saber o tenant ainda. Define
    // `app.user_email` dentro de uma transação para que a política RLS de
    // `organization_invitation` libere somente convites endereçados a este
    // usuário (defesa em profundidade: o token sozinho não basta).
    const tokenHash = hashInviteToken(token)
    let invitation: typeof t.organizationInvitation.$inferSelect | undefined
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_email', ${authenticatedEmail}, true)`)
      const rows = await tx
        .select()
        .from(t.organizationInvitation)
        .where(
          and(eq(t.organizationInvitation.tokenHash, tokenHash), isNull(t.organizationInvitation.acceptedAt)),
        )
        .limit(1)
      invitation = rows[0]
    })

    if (!invitation) {
      throw new Error('invitation not found or already accepted')
    }

    const {
      organizationInvitationId: invitationId,
      tenantId: invitationTenantId,
      role: invitationRole,
    } = invitation

    if (invitation.expiresAt < new Date()) {
      throw new Error('invitation expired')
    }

    // Verifica se o e-mail da conta autenticada corresponde ao do convite.
    if (normalizeEmail(invitation.email) !== authenticatedEmail) {
      throw new Error('invitation not addressed to this user')
    }

    // Consome o convite e cria a associação de forma atômica dentro do
    // contexto de tenant do convite. O `WHERE acceptedAt IS NULL` garante
    // que apenas uma requisição concorrente consiga reclamar o convite.
    const member = await withTenant(db, invitationTenantId, async (tx) => {
      const claimed = await tx
        .update(t.organizationInvitation)
        .set({ acceptedAt: new Date(), acceptedBy: userId })
        .where(
          and(
            eq(t.organizationInvitation.organizationInvitationId, invitationId),
            isNull(t.organizationInvitation.acceptedAt),
          ),
        )
        .returning()

      if (claimed.length === 0) {
        throw new Error('invitation not found or already accepted')
      }

      // Verifica se o usuário já é membro dentro do escopo do tenant.
      const existing = await tx
        .select({ userId: t.organizationMember.userId })
        .from(t.organizationMember)
        .where(
          and(eq(t.organizationMember.tenantId, invitationTenantId), eq(t.organizationMember.userId, userId)),
        )
        .limit(1)

      if (existing.length > 0) {
        throw new Error('user is already a member')
      }

      // Adiciona o usuário como membro.
      const insertedMembers = await tx
        .insert(t.organizationMember)
        .values({
          organizationMemberId: randomUUID(),
          tenantId: invitationTenantId,
          userId,
          role: invitationRole,
          invitedBy: null,
        })
        .returning()

      return insertedMembers[0]
    })

    if (!member) {
      throw new Error('failed to create membership')
    }

    return {
      organizationMemberId: member.organizationMemberId,
      tenantId: member.tenantId,
      userId: member.userId,
      userEmail: invitation.email,
      userName: authenticatedUser.name ?? '',
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
  role?: string | null
  legalName?: string | null
  document?: string | null
}): OrganizationDto {
  return {
    tenantId: tenant.tenantId,
    name: tenant.name,
    legalName: tenant.legalName ?? null,
    document: tenant.document ?? null,
    type: tenant.type,
    status: tenant.status,
    onboardingStatus: tenant.onboardingStatus,
    termsAcceptedAt:
      tenant.termsAcceptedAt !== null && tenant.termsAcceptedAt !== undefined
        ? tenant.termsAcceptedAt.toISOString()
        : null,
    termsAcceptedBy: tenant.termsAcceptedBy ?? null,
    termsVersion: tenant.termsVersion,
    dataRegion: tenant.dataRegion,
    rateLimitRps: tenant.rateLimitRps,
    burst: tenant.burst,
    monthlyQuota: tenant.monthlyQuota !== null ? Number(tenant.monthlyQuota) : null,
    createdAt: tenant.createdAt.toISOString(),
    role: tenant.role ?? null,
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
  role: string
}): OrganizationDto {
  return mapTenantToDto(row)
}
