import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { PROBLEM_CONTENT_TYPE, problem } from '@comprova/contracts'

export interface MeResponse {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly role: string
}

const sendProblem = (reply: FastifyReply, status: number, code: string, message: string): FastifyReply =>
  reply
    .code(status)
    .type(PROBLEM_CONTENT_TYPE)
    .send(problem(status, code, message))

export const registerMeRoute = (
  app: FastifyInstance,
  requireWriteScope: (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>,
): void => {
  app.addHook('preHandler', requireWriteScope)

  app.get('/me', async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const sessionUser = request.sessionUser
    if (sessionUser === undefined) {
      return sendProblem(reply, 401, 'UNAUTHORIZED', 'Sessão não encontrada')
    }

    return reply.code(200).send({
      id: sessionUser.id,
      email: sessionUser.email,
      name: sessionUser.name,
      role: sessionUser.role,
    } as MeResponse)
  })
}
