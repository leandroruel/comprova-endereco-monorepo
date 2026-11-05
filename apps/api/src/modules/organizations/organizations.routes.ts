import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db } from '@comprova/db'
import { PROBLEM_CONTENT_TYPE, problems } from '@comprova/contracts'
import { makeOrganizationsController } from './organizations.controller.js'
import {
  CompleteOnboardingBody,
  CreateOrganizationBody,
  OrganizationResponse,
  OrganizationMemberResponse,
  OrganizationInvitationCreatedResponse,
  ProblemResponse,
  AddMemberBody,
  InviteMemberBody,
  AcceptInvitationBody,
  TenantIdParams,
} from './organizations.schema.js'
import { requireOrganizationAccess, requireAdminOrOwner } from '../../plugins/organization.js'

const requireSessionUser = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> => {
  if (request.sessionUser === undefined) {
    return reply.code(401).type(PROBLEM_CONTENT_TYPE).send(problems.unauthorized())
  }
}

export type OrganizationsRoutesDeps = {
  readonly db: Db
  /** Versão vigente dos termos, definida pelo servidor (config `TERMS_VERSION`). */
  readonly termsVersion: string
  /** Indica se o conteúdo jurídico dos termos foi aprovado e pode ser aceito. */
  readonly termsApproved: boolean
}

export const registerOrganizationsRoutes = (
  instance: FastifyInstance,
  deps: OrganizationsRoutesDeps,
): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const controller = makeOrganizationsController(deps)

  // Rotas que não exigem membership prévio (criar e listar por usuário)
  // não usam requireOrganizationAccess.

  app.post(
    '/organizations',
    {
      preHandler: requireSessionUser,
      schema: {
        body: CreateOrganizationBody,
        response: { 201: OrganizationResponse },
      },
    },
    async (request, reply) => {
      const userId = request.sessionUser!.id
      return controller.create(
        {
          name: request.body.name,
          legalName: request.body.legalName,
          document: request.body.document,
          termsVersion: request.body.termsVersion,
          dataRegion: request.body.dataRegion,
          userId,
        },
        reply,
      )
    },
  )

  app.get(
    '/organizations',
    {
      preHandler: requireSessionUser,
      schema: {
        response: { 200: z.array(OrganizationResponse) },
      },
    },
    async (request, reply) => {
      return controller.listByUser(request.sessionUser!.id, reply)
    },
  )

  // Versão vigente dos termos de onboarding, definida pelo servidor. O
  // frontend deve consumir este endpoint e registrar a manifestação de
  // aceite sem permitir que o cliente escolha livremente a versão.
  app.get(
    '/organizations/terms-version',
    {
      preHandler: requireSessionUser,
      schema: {
        response: { 200: z.object({ version: z.string(), approved: z.boolean() }) },
      },
    },
    async (_request, reply) => {
      return reply.code(200).send({ version: deps.termsVersion, approved: deps.termsApproved })
    },
  )

  app.get(
    '/organizations/:tenantId',
    {
      preHandler: requireOrganizationAccess(deps.db),
      schema: {
        params: TenantIdParams,
        response: { 200: OrganizationResponse },
      },
    },
    async (request, reply) => {
      return controller.get({ tenantId: request.params.tenantId, userId: request.sessionUser!.id }, reply)
    },
  )

  app.post(
    '/organizations/:tenantId/onboarding/complete',
    {
      preHandler: requireOrganizationAccess(deps.db),
      schema: {
        params: TenantIdParams,
        body: CompleteOnboardingBody,
        response: { 200: OrganizationResponse },
      },
    },
    async (request, reply) => {
      return controller.completeOnboarding(
        {
          tenantId: request.params.tenantId,
          userId: request.sessionUser!.id,
          termsVersion: request.body.termsVersion,
        },
        reply,
      )
    },
  )

  app.post(
    '/organizations/:tenantId/members',
    {
      preHandler: [requireOrganizationAccess(deps.db), requireAdminOrOwner],
      schema: {
        params: TenantIdParams,
        body: AddMemberBody,
        response: {
          201: OrganizationMemberResponse,
          403: ProblemResponse,
          404: ProblemResponse,
          409: ProblemResponse,
        },
      },
    },
    async (request, reply) => {
      return controller.addMember(
        {
          tenantId: request.params.tenantId,
          email: request.body.email,
          role: request.body.role,
          userId: request.sessionUser!.id,
        },
        reply,
      )
    },
  )

  app.get(
    '/organizations/:tenantId/members',
    {
      preHandler: requireOrganizationAccess(deps.db),
      schema: {
        params: TenantIdParams,
        response: { 200: z.array(OrganizationMemberResponse) },
      },
    },
    async (request, reply) => {
      return controller.listMembers(
        { tenantId: request.params.tenantId, userId: request.sessionUser!.id },
        reply,
      )
    },
  )

  app.post(
    '/organizations/:tenantId/invitations',
    {
      preHandler: [requireOrganizationAccess(deps.db), requireAdminOrOwner],
      schema: {
        params: TenantIdParams,
        body: InviteMemberBody,
        response: {
          201: OrganizationInvitationCreatedResponse,
          403: ProblemResponse,
          404: ProblemResponse,
        },
      },
    },
    async (request, reply) => {
      return controller.createInvitation(
        {
          tenantId: request.params.tenantId,
          email: request.body.email,
          role: request.body.role,
          expiresInDays: request.body.expiresInDays,
          userId: request.sessionUser!.id,
        },
        reply,
      )
    },
  )

  app.post(
    '/organizations/invitations/accept',
    {
      preHandler: requireSessionUser,
      schema: {
        body: AcceptInvitationBody,
        response: { 200: OrganizationMemberResponse },
      },
    },
    async (request, reply) => {
      return controller.acceptInvitation(
        {
          token: request.body.token,
          userId: request.sessionUser!.id,
        },
        reply,
      )
    },
  )
}
