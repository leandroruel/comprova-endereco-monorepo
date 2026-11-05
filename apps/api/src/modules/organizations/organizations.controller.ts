import type { FastifyReply } from 'fastify'
import type { Db } from '@comprova/db'
import type {
  OrganizationMemberResponseType,
  OrganizationResponseType,
  OrganizationInvitationCreatedResponseType,
} from './organizations.schema.js'
import { PROBLEM_CONTENT_TYPE, problem } from '@comprova/contracts'
import { makeOrganizationsService } from './organizations.service.js'

const sendProblem = (
  reply: FastifyReply,
  status: number,
  code: string,
  title: string,
  detail?: string,
): FastifyReply =>
  reply
    .code(status)
    .type(PROBLEM_CONTENT_TYPE)
    .send(problem(status, code, title, detail))

export const makeOrganizationsController = (deps: {
  readonly db: Db
  readonly termsVersion: string | null
  readonly termsApproved: boolean
  readonly termsDocumentHash: string | null
}) => {
  const service = makeOrganizationsService({
    db: deps.db,
    termsVersion: deps.termsVersion,
    termsApproved: deps.termsApproved,
    termsDocumentHash: deps.termsDocumentHash,
  })

  type CreateOrgInput = {
    name: string
    legalName?: string
    document?: string
    termsVersion: string
    dataRegion?: string
    userId: string
  }

  type CompleteOnboardingInput = {
    tenantId: string
    userId: string
    termsVersion: string
  }

  type AddMemberInput = {
    tenantId: string
    email: string
    role: 'owner' | 'admin' | 'member'
    userId: string
  }

  type CreateInvitationInput = {
    tenantId: string
    email: string
    role: 'owner' | 'admin' | 'member'
    expiresInDays?: number
    userId: string
  }

  type AcceptInvitationInput = {
    token: string
    userId: string
  }

  return {
    create: async (
      input: CreateOrgInput,
      reply: FastifyReply,
    ): Promise<OrganizationResponseType | FastifyReply> => {
      try {
        const organization = await service.createOrganization(
          {
            name: input.name,
            legalName: input.legalName,
            document: input.document,
            termsVersion: input.termsVersion,
            dataRegion: input.dataRegion ?? 'sa-east-1',
          },
          input.userId,
        )
        return reply.code(201).send(organization)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === 'user not found') {
          return sendProblem(reply, 404, 'USER_NOT_FOUND', 'Usuário não encontrado')
        }
        return sendProblem(reply, 500, 'INTERNAL_ERROR', 'Erro ao criar organização')
      }
    },

    listByUser: async (
      userId: string,
      reply: FastifyReply,
    ): Promise<OrganizationResponseType[] | FastifyReply> => {
      const organizations = await service.listOrganizationsByUser(userId)
      return reply.code(200).send(organizations)
    },

    get: async (
      input: { tenantId: string; userId: string },
      reply: FastifyReply,
    ): Promise<OrganizationResponseType | FastifyReply> => {
      const organization = await service.getOrganization(input.tenantId, input.userId)

      if (!organization) {
        return sendProblem(reply, 404, 'ORGANIZATION_NOT_FOUND', 'Organização não encontrada')
      }

      return reply.code(200).send(organization)
    },

    completeOnboarding: async (
      input: CompleteOnboardingInput,
      reply: FastifyReply,
    ): Promise<OrganizationResponseType | FastifyReply> => {
      try {
        const organization = await service.completeOnboarding(
          input.tenantId,
          input.userId,
          input.termsVersion,
        )
        return reply.code(200).send(organization)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === 'only the organization owner can complete onboarding') {
          return sendProblem(reply, 403, 'FORBIDDEN', 'Apenas o owner pode completar o onboarding')
        }
        if (message === 'organization not found') {
          return sendProblem(reply, 404, 'ORGANIZATION_NOT_FOUND', 'Organização não encontrada')
        }
        if (message === 'terms version does not match the current version') {
          return sendProblem(
            reply,
            409,
            'TERMS_VERSION_MISMATCH',
            'A versão dos termos não corresponde à versão vigente',
          )
        }
        if (message === 'terms not approved: legal content pending approval') {
          return sendProblem(
            reply,
            403,
            'TERMS_NOT_APPROVED',
            'O conteúdo jurídico dos termos ainda não foi aprovado. O onboarding não pode ser concluído.',
          )
        }
        return sendProblem(reply, 500, 'INTERNAL_ERROR', 'Erro ao completar onboarding')
      }
    },

    addMember: async (
      input: AddMemberInput,
      reply: FastifyReply,
    ): Promise<OrganizationMemberResponseType | FastifyReply> => {
      try {
        const member = await service.addMember(
          input.tenantId,
          { email: input.email, role: input.role },
          input.userId,
        )
        return reply.code(201).send(member)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === 'only owners and admins can add members') {
          return sendProblem(reply, 403, 'FORBIDDEN', 'Apenas owners e admins podem adicionar membros')
        }
        if (message === 'only the owner can grant the owner role') {
          return sendProblem(reply, 403, 'FORBIDDEN', 'Apenas o owner pode conceder o papel de owner')
        }
        if (message === 'user not found') {
          return sendProblem(reply, 404, 'USER_NOT_FOUND', 'Usuário não encontrado')
        }
        if (message === 'user is already a member') {
          return sendProblem(reply, 409, 'MEMBER_ALREADY_EXISTS', 'Usuário já é membro')
        }
        if (message === 'a organização já possui um proprietário') {
          return sendProblem(
            reply,
            403,
            'ORGANIZATION_ALREADY_HAS_OWNER',
            'A organização já possui um proprietário',
          )
        }
        return sendProblem(reply, 500, 'INTERNAL_ERROR', 'Erro ao adicionar membro')
      }
    },

    listMembers: async (
      input: { tenantId: string; userId: string },
      reply: FastifyReply,
    ): Promise<OrganizationMemberResponseType[] | FastifyReply> => {
      const members = await service.listMembers(input.tenantId, input.userId)
      return reply.code(200).send(members)
    },

    createInvitation: async (
      input: CreateInvitationInput,
      reply: FastifyReply,
    ): Promise<OrganizationInvitationCreatedResponseType | FastifyReply> => {
      try {
        const invitation = await service.createInvitation(
          input.tenantId,
          input.email,
          input.role,
          input.userId,
          input.expiresInDays ?? 7,
        )
        return reply.code(201).send({
          organizationInvitationId: invitation.organizationInvitationId,
          tenantId: invitation.tenantId,
          email: invitation.email,
          role: invitation.role,
          expiresAt: invitation.expiresAt,
          createdAt: invitation.createdAt,
          token: invitation.token,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === 'only owners and admins can create invitations') {
          return sendProblem(reply, 403, 'FORBIDDEN', 'Apenas owners e admins podem criar convites')
        }
        if (message === 'only the owner can grant the owner role') {
          return sendProblem(reply, 403, 'FORBIDDEN', 'Apenas o owner pode conceder o papel de owner')
        }
        if (message === 'a organização já possui um proprietário') {
          return sendProblem(
            reply,
            403,
            'ORGANIZATION_ALREADY_HAS_OWNER',
            'A organização já possui um proprietário',
          )
        }
        return sendProblem(reply, 500, 'INTERNAL_ERROR', 'Erro ao criar convite')
      }
    },

    acceptInvitation: async (
      input: AcceptInvitationInput,
      reply: FastifyReply,
    ): Promise<OrganizationMemberResponseType | FastifyReply> => {
      try {
        const member = await service.acceptInvitation(input.token, input.userId)
        return reply.code(200).send(member)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === 'invitation not found or already accepted') {
          return sendProblem(reply, 404, 'INVITATION_NOT_FOUND', 'Convite não encontrado ou já aceito')
        }
        if (message === 'invitation expired') {
          return sendProblem(reply, 410, 'INVITATION_EXPIRED', 'Convite expirado')
        }
        if (message === 'user is already a member') {
          return sendProblem(reply, 409, 'MEMBER_ALREADY_EXISTS', 'Usuário já é membro')
        }
        if (message === 'invitation not addressed to this user') {
          return sendProblem(reply, 403, 'FORBIDDEN', 'Convite não endereçado a este usuário')
        }
        return sendProblem(reply, 500, 'INTERNAL_ERROR', 'Erro ao aceitar convite')
      }
    },
  }
}
