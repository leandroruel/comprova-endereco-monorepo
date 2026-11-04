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
          email: request.body.email,
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
      return controller.get(
        { tenantId: request.params.tenantId, userId: request.sessionUser!.id },
        reply,
      )
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
        response: { 201: OrganizationMemberResponse, 403: z.object({}), 404: z.object({}) },
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
