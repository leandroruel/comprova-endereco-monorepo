import { PROBLEM_CONTENT_TYPE, problems } from '@comprova/contracts'
import { and, eq } from '@comprova/db'
import * as t from '@comprova/db'
import type { FastifyReply, FastifyRequest } from 'fastify'

export interface OrganizationContext {
  readonly tenantId: string
  readonly userId: string
  readonly role: string
}

declare module 'fastify' {
  interface FastifyRequest {
    organization?: OrganizationContext
  }
}

const unauthorized = (reply: FastifyReply): FastifyReply =>
  reply.code(401).type(PROBLEM_CONTENT_TYPE).send(problems.unauthorized())

const forbidden = (reply: FastifyReply): FastifyReply =>
  reply.code(403).type(PROBLEM_CONTENT_TYPE).send(problems.forbidden())

/**
 * Garante que o usuário autenticado por sessão pertença à organização
 * informada no parâmetro `tenantId`. Preenche `request.organization`.
 *
 * Deve rodar como `preHandler` de rotas montadas DEPOIS do
 * `makeSessionMiddleware` (que preenche `request.sessionUser`).
 */
export const requireOrganizationAccess =
  (db: t.Db) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const sessionUser = request.sessionUser
    if (sessionUser === undefined) {
      return unauthorized(reply)
    }

    const { tenantId } = request.params as { readonly tenantId: string }
    if (!tenantId) {
      return forbidden(reply)
    }

    const membership = await db
      .select({
        role: t.organizationMember.role,
      })
      .from(t.organizationMember)
      .where(
        and(eq(t.organizationMember.tenantId, tenantId), eq(t.organizationMember.userId, sessionUser.id)),
      )
      .limit(1)

    if (membership.length === 0) {
      return forbidden(reply)
    }

    const role = membership[0]?.role
    if (!role) {
      return forbidden(reply)
    }

    request.organization = {
      tenantId,
      userId: sessionUser.id,
      role,
    }
  }

/**
 * Garante que o usuário tenha um papel mínimo na organização.
 * `allowedRoles` em ordem de hierarquia: owner > admin > member.
 */
export const requireOrgRole =
  (allowedRoles: readonly string[]) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const organization = request.organization
    if (organization === undefined) {
      return unauthorized(reply)
    }

    const hierarchy = ['member', 'admin', 'owner']
    const userLevel = hierarchy.indexOf(organization.role)
    const minLevel = Math.min(...allowedRoles.map((r) => hierarchy.indexOf(r)))

    if (userLevel < minLevel) {
      return forbidden(reply)
    }
  }

export const requireOwner = requireOrgRole(['owner'])
export const requireAdminOrOwner = requireOrgRole(['admin', 'owner'])
